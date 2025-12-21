import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import { getDBFromContext, queryAll, queryOne, execute } from "~/lib/d1.server";
import { getSession } from "~/lib/session.server";
import { assertNotBanned, findUserById, requireUser } from "~/lib/auth.server";
import { getAttachmentStorageUsage, listAttachmentsByPostId, removeAllAttachmentsForPost } from "~/lib/attachments.server";
import type { AttachmentRecord } from "~/lib/attachments.server";

const attachmentLimits = {
	MIN_FILE_SIZE_BYTES: 1024,
	MAX_FILE_SIZE_BYTES: 100 * 1024 * 1024,
	MAX_ATTACHMENTS_PER_POST: 3,
	MULTIPART_THRESHOLD_BYTES: 10 * 1024 * 1024,
	PART_SIZE_BYTES: 5 * 1024 * 1024,
} as const;

type PostDetail = {
	id: number;
	title: string;
	content: string;
	createdAt: number;
	authorId: number;
	authorName: string;
};

type CommentItem = {
	id: number;
	content: string;
	createdAt: number;
	authorName: string;
};

type LoaderData = {
	user: Awaited<ReturnType<typeof findUserById>>;
	post: PostDetail;
	attachments: AttachmentRecord[];
	attachmentStorage: {
		usedBytes: number;
		reservedBytes: number;
		limitBytes: number;
		paused: boolean;
	};
	comments: CommentItem[];
	commentCount: number;
	likeCount: number;
	likedByMe: boolean;
	page: number;
	pageSize: number;
	totalPages: number;
};

type ActionData = {
	fieldErrors?: {
		content?: string;
	};
	formError?: string;
};

function parsePositiveInt(value: string | null, fallback: number) {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
	const session = await getSession(request, context);
	const userId = session.get("userId") as number | undefined;
	let user: Awaited<ReturnType<typeof findUserById>> = null;
	if (userId) {
		user = await findUserById(context, userId);
	}

	const url = new URL(request.url);
	const pageSize = 20;
	const requestedPage = parsePositiveInt(url.searchParams.get("page"), 1);

	const rawId = params.id;
	const id = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(id)) {
		throw new Response("无效的帖子ID", { status: 400 });
	}
	const db = getDBFromContext(context);
	const post = await queryOne<PostDetail>(
		db,
		"SELECT posts.id as id, posts.title as title, posts.content as content, posts.created_at as createdAt, posts.author_id as authorId, users.display_name as authorName FROM posts JOIN users ON posts.author_id = users.id WHERE posts.id = ?",
		[id],
	);
	if (!post) {
		throw new Response("帖子不存在", { status: 404 });
	}

	const commentCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM comments WHERE post_id = ?",
		[id],
	);
	const commentCount = Number(commentCountRow?.count ?? 0);
	const totalPages = Math.max(1, Math.ceil(commentCount / pageSize));
	const page = Math.min(requestedPage, totalPages);
	const offset = (page - 1) * pageSize;

	const likeCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM post_likes WHERE post_id = ?",
		[id],
	);
	const likeCount = Number(likeCountRow?.count ?? 0);

	let likedByMe = false;
	if (userId) {
		const liked = await queryOne<{ liked: number }>(
			db,
			"SELECT 1 as liked FROM post_likes WHERE post_id = ? AND user_id = ? LIMIT 1",
			[id, userId],
		);
		likedByMe = Boolean(liked?.liked);
	}

	const comments = await queryAll<CommentItem>(
		db,
		"SELECT comments.id as id, comments.content as content, comments.created_at as createdAt, users.display_name as authorName FROM comments JOIN users ON comments.author_id = users.id WHERE comments.post_id = ? ORDER BY comments.created_at ASC LIMIT ? OFFSET ?",
		[id, pageSize, offset],
	);

	const attachments = await listAttachmentsByPostId(context, id);
	const attachmentStorage = await getAttachmentStorageUsage(context);

	return json<LoaderData>({
		user,
		post,
		attachments,
		attachmentStorage,
		comments,
		commentCount,
		likeCount,
		likedByMe,
		page,
		pageSize,
		totalPages,
	});
}

export async function action({ request, context, params }: ActionFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);
	const userId = user.id;
	const rawId = params.id;
	const postId = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(postId)) {
		return json<ActionData>({ formError: "无效的帖子ID" }, { status: 400 });
	}
	const formData = await request.formData();
	const intent = String(formData.get("intent") || "comment");
	const db = getDBFromContext(context);
	const currentUrl = new URL(request.url);

	if (intent === "delete") {
		const postOwner = await queryOne<{ authorId: number }>(
			db,
			"SELECT author_id as authorId FROM posts WHERE id = ?",
			[postId],
		);
		if (!postOwner) {
			return json<ActionData>({ formError: "帖子不存在" }, { status: 404 });
		}
		if (postOwner.authorId !== userId) {
			return json<ActionData>({ formError: "无权删除该帖子" }, { status: 403 });
		}
		try {
			await removeAllAttachmentsForPost(context, postId);
			await execute(db, "DELETE FROM post_likes WHERE post_id = ?", [postId]);
			await execute(db, "DELETE FROM comments WHERE post_id = ?", [postId]);
			await execute(db, "DELETE FROM posts WHERE id = ?", [postId]);
			return redirect("/posts");
		} catch (error) {
			return json<ActionData>({ formError: "删帖失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "toggleLike") {
		const postOwner = await queryOne<{ authorId: number }>(
			db,
			"SELECT author_id as authorId FROM posts WHERE id = ?",
			[postId],
		);
		if (!postOwner) {
			return json<ActionData>({ formError: "帖子不存在" }, { status: 404 });
		}
		if (postOwner.authorId === userId) {
			return json<ActionData>({ formError: "不能给自己的帖子点赞" }, { status: 400 });
		}
		try {
			const liked = await queryOne<{ liked: number }>(
				db,
				"SELECT 1 as liked FROM post_likes WHERE post_id = ? AND user_id = ? LIMIT 1",
				[postId, userId],
			);
			if (liked) {
				await execute(db, "DELETE FROM post_likes WHERE post_id = ? AND user_id = ?", [postId, userId]);
			} else {
				await execute(
					db,
					"INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)",
					[postId, userId, Date.now()],
				);
			}
			return redirect(`${currentUrl.pathname}${currentUrl.search}`);
		} catch (error) {
			return json<ActionData>({ formError: "点赞失败，请稍后重试" }, { status: 500 });
		}
	}

	const content = String(formData.get("content") || "").trim();
	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!content) {
		fieldErrors.content = "请输入评论内容";
	}
	if (fieldErrors.content) {
		return json<ActionData>({ fieldErrors }, { status: 400 });
	}
	try {
		const createdAt = Date.now();
		await execute(
			db,
			"INSERT INTO comments (post_id, content, author_id, created_at) VALUES (?, ?, ?, ?)",
			[postId, content, userId, createdAt],
		);
		return redirect(`${currentUrl.pathname}${currentUrl.search}`);
	} catch (error) {
		return json<ActionData>({ formError: "发表评论失败，请稍后重试" }, { status: 500 });
	}
}

export default function PostDetailPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	const isBanned = Boolean(data.user?.isBanned);
	const commentStartIndex = (data.page - 1) * data.pageSize;
	const canPrev = data.page > 1;
	const canNext = data.page < data.totalPages;
	const isAuthor = Boolean(data.user && data.user.id === data.post.authorId);
	const canManageAttachments = Boolean(isAuthor && !isBanned);
	const uploadsPaused = data.attachmentStorage.paused;
	const canUpload = Boolean(canManageAttachments && !uploadsPaused);

	type UploadItem = {
		id: string;
		file: File;
		status: "pending" | "uploading" | "done" | "error";
		progress: number;
		error: string | null;
	};

	const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
	const [queue, setQueue] = useState<UploadItem[]>([]);
	const [busy, setBusy] = useState(false);
	const [globalError, setGlobalError] = useState<string | null>(null);

	const remainingSlots = useMemo(() => {
		const existing = data.attachments.length;
		const uploading = queue.filter((q) => q.status === "pending" || q.status === "uploading").length;
		return Math.max(0, attachmentLimits.MAX_ATTACHMENTS_PER_POST - existing - uploading);
	}, [data.attachments.length, queue]);

	function formatSize(bytes: number) {
		if (!Number.isFinite(bytes) || bytes < 0) return "-";
		if (bytes < 1024) return `${bytes} B`;
		const kb = bytes / 1024;
		if (kb < 1024) return `${kb.toFixed(1)} KB`;
		const mb = kb / 1024;
		if (mb < 1024) return `${mb.toFixed(1)} MB`;
		const gb = mb / 1024;
		return `${gb.toFixed(2)} GB`;
	}

	function validateLocal(file: File) {
		if (file.size < attachmentLimits.MIN_FILE_SIZE_BYTES || file.size > attachmentLimits.MAX_FILE_SIZE_BYTES) {
			return `文件大小需在 ${formatSize(attachmentLimits.MIN_FILE_SIZE_BYTES)} 到 ${formatSize(attachmentLimits.MAX_FILE_SIZE_BYTES)} 之间`;
		}
		const name = String(file.name || "");
		const idx = name.lastIndexOf(".");
		const ext = idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
		const allowed = new Set([
			"pdf",
			"txt",
			"md",
			"csv",
			"json",
			"doc",
			"docx",
			"xls",
			"xlsx",
			"ppt",
			"pptx",
			"png",
			"jpg",
			"jpeg",
			"gif",
			"webp",
			"mp4",
			"mov",
			"webm",
			"mp3",
			"wav",
			"zip",
			"rar",
			"7z",
			"tar",
			"gz",
		]);
		if (!ext || !allowed.has(ext)) {
			return "不支持的文件类型";
		}
		return null;
	}

	useEffect(() => {
		setSelectedFiles([]);
		setQueue([]);
		setBusy(false);
		setGlobalError(null);
	}, [data.post.id]);

	async function requestDownload(attachmentId: number) {
		setGlobalError(null);
		try {
			const res = await fetch(`/api/attachments/${attachmentId}/token`, { method: "GET" });
			const body = (await res.json()) as any;
			if (!res.ok || !body?.ok) {
				throw new Error(String(body?.error || "获取下载链接失败"));
			}
			const token = String(body.token || "");
			window.location.href = `/attachments/${attachmentId}?token=${encodeURIComponent(token)}`;
		} catch (e) {
			setGlobalError(e instanceof Error ? e.message : "获取下载链接失败");
		}
	}

	async function initiateUpload(postId: number, file: File) {
		const res = await fetch(`/api/posts/${postId}/attachments/initiate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
		});
		const body = (await res.json()) as any;
		if (!res.ok || !body?.ok) {
			throw new Error(String(body?.error || "创建上传任务失败"));
		}
		return body as {
			uploadRecordId: number;
			mode: "single" | "multipart";
			uploadId: string;
			partSizeBytes: number | null;
		};
	}

	async function uploadSingle(uploadRecordId: number, file: File) {
		const form = new FormData();
		form.append("file", file);
		const res = await fetch(`/api/attachment-uploads/${uploadRecordId}/upload`, { method: "POST", body: form });
		const body = (await res.json()) as any;
		if (!res.ok || !body?.ok) {
			throw new Error(String(body?.error || "上传失败"));
		}
	}

	async function uploadMultipart(uploadRecordId: number, file: File, partSizeBytes: number, onProgress: (p: number) => void) {
		const totalParts = Math.ceil(file.size / partSizeBytes);
		for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
			const start = (partNumber - 1) * partSizeBytes;
			const end = Math.min(file.size, partNumber * partSizeBytes);
			const chunk = file.slice(start, end);
			const body = await chunk.arrayBuffer();
			const res = await fetch(`/api/attachment-uploads/${uploadRecordId}/parts/${partNumber}`, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body,
			});
			const data = (await res.json()) as any;
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "上传分块失败"));
			}
			onProgress(partNumber / totalParts);
		}
		const doneRes = await fetch(`/api/attachment-uploads/${uploadRecordId}/complete`, { method: "POST" });
		const done = (await doneRes.json()) as any;
		if (!doneRes.ok || !done?.ok) {
			throw new Error(String(done?.error || "完成上传失败"));
		}
	}

	async function startUpload() {
		if (!canUpload) {
			if (canManageAttachments && uploadsPaused) {
				setGlobalError("网站总存储量已超过 9GB，已暂停附件上传");
			}
			return;
		}
		setGlobalError(null);
		if (selectedFiles.length === 0) {
			setGlobalError("请选择要上传的文件");
			return;
		}
		if (remainingSlots <= 0) {
			setGlobalError("该帖子附件数量已达上限");
			return;
		}
		const files = selectedFiles.slice(0, remainingSlots);
		const items: UploadItem[] = files.map((file) => ({
			id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
			file,
			status: "pending",
			progress: 0,
			error: null,
		}));
		setQueue(items);
		setBusy(true);
		for (const item of items) {
			setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "uploading", progress: 0 } : q)));
			try {
				const localError = validateLocal(item.file);
				if (localError) {
					throw new Error(localError);
				}
				const init = await initiateUpload(data.post.id, item.file);
				if (init.mode === "single") {
					await uploadSingle(init.uploadRecordId, item.file);
					setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, progress: 1 } : q)));
				} else {
					const partSize = init.partSizeBytes || attachmentLimits.PART_SIZE_BYTES;
					await uploadMultipart(init.uploadRecordId, item.file, partSize, (p) => {
						setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, progress: p } : q)));
					});
				}
				setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "done", progress: 1 } : q)));
			} catch (e) {
				const message = e instanceof Error ? e.message : "上传失败";
				setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "error", error: message } : q)));
			}
		}
		setBusy(false);
		setSelectedFiles([]);
		window.location.reload();
	}

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex items-center justify-between">
					<div>
						<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
							{data.post.title}
						</h1>
						<p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
							<span>作者：{data.post.authorName}</span>
							<span className="ml-3">
								发布时间：{new Date(data.post.createdAt).toLocaleString()}
							</span>
							<span className="ml-3">评论：{data.commentCount}</span>
							<span className="ml-3">点赞：{data.likeCount}</span>
						</p>
					</div>
				</header>
				<main className="flex flex-col gap-6">
					{isBanned ? (
						<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
							账号已被封禁，无法删帖、点赞或发表评论。
						</div>
					) : null}
					{globalError ? (
						<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
							{globalError}
						</div>
					) : null}
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<div className="mb-4 flex items-center justify-between gap-3">
							<Link
								to="/posts"
								className="text-sm text-blue-600 hover:underline dark:text-blue-400"
							>
								返回列表
							</Link>
							<div className="flex items-center gap-2">
								{data.user && data.user.id === data.post.authorId ? (
									isBanned ? (
										<button
											type="button"
											disabled
											className="cursor-not-allowed rounded bg-gray-300 px-3 py-1 text-sm font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
										>
											删帖
										</button>
									) : (
										<Form method="post">
											<input type="hidden" name="intent" value="delete" />
											<button
												type="submit"
												className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
											>
												删帖
											</button>
										</Form>
									)
								) : null}
								{data.user ? (
									data.user.id !== data.post.authorId ? (
										isBanned ? (
											<button
												type="button"
												disabled
												className="cursor-not-allowed rounded bg-gray-300 px-3 py-1 text-sm font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
											>
												点赞
											</button>
										) : (
											<Form method="post">
												<input type="hidden" name="intent" value="toggleLike" />
												<button
													type="submit"
													className={
														data.likedByMe
															? "rounded bg-gray-800 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
															: "rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
													}
												>
													{data.likedByMe ? "已赞" : "点赞"}
												</button>
											</Form>
										)
									) : (
										<button
											type="button"
											disabled
											className="cursor-not-allowed rounded bg-gray-300 px-3 py-1 text-sm font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
										>
											点赞
										</button>
									)
								) : (
									<a
										href="/login"
										className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
									>
										登录后点赞
									</a>
								)}
							</div>
						</div>
						{actionData?.formError ? (
							<p className="mb-3 text-sm text-red-600">{actionData.formError}</p>
						) : null}
						<div className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800 dark:text-gray-100">
							{data.post.content}
						</div>
					</section>
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<div className="mb-4 flex items-center justify-between gap-3">
							<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
								附件（{data.attachments.length} / {attachmentLimits.MAX_ATTACHMENTS_PER_POST}）
							</h2>
							<span className="text-xs text-gray-500 dark:text-gray-400">
								单附件大小：{formatSize(attachmentLimits.MIN_FILE_SIZE_BYTES)}~{formatSize(attachmentLimits.MAX_FILE_SIZE_BYTES)}
							</span>
						</div>
						{data.attachments.length === 0 ? (
							<p className="text-sm text-gray-600 dark:text-gray-300">暂无附件。</p>
						) : (
							<ul className="space-y-2">
								{data.attachments.map((a) => (
									<li
										key={a.id}
										className="flex items-center justify-between gap-3 rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700"
									>
										<div className="min-w-0">
											<div className="truncate font-medium text-gray-900 dark:text-gray-100">{a.filename}</div>
											<div className="text-xs text-gray-500 dark:text-gray-400">
												{formatSize(a.sizeBytes)} · {new Date(a.createdAt).toLocaleString()}
											</div>
										</div>
										{data.user ? (
											<button
												type="button"
												onClick={() => requestDownload(a.id)}
												disabled={isBanned}
												className={
													isBanned
														? "cursor-not-allowed rounded bg-gray-300 px-3 py-1 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
													: "rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
												}
											>
												下载
											</button>
										) : (
											<a
												href="/login"
												className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
											>
												登录后下载
											</a>
										)}
									</li>
								))}
							</ul>
						)}

						{canManageAttachments ? (
							<div className="mt-6 rounded border border-gray-200 p-4 dark:border-gray-700">
								<div className="flex flex-col gap-3">
									<div className="flex items-center justify-between">
										<label className="text-sm font-medium text-gray-900 dark:text-gray-100">
											上传附件
										</label>
										<span className="text-xs text-gray-500 dark:text-gray-400">
											剩余可上传：{remainingSlots} 个
										</span>
									</div>
									{uploadsPaused ? (
										<div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
											网站总存储量已超过 9GB，已暂停附件上传
										</div>
									) : null}
					<input
						type="file"
						multiple
										disabled={busy || remainingSlots <= 0 || uploadsPaused}
						onChange={(e) => {
							const files = Array.from(e.target.files || []);
							setSelectedFiles(files);
						}}
						className="block w-full text-sm text-gray-700 file:mr-4 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-900 hover:file:bg-gray-200 dark:text-gray-200 dark:file:bg-gray-900 dark:file:text-gray-100 dark:hover:file:bg-gray-800"
					/>
									<div className="flex items-center justify-between">
										<span className="text-xs text-gray-500 dark:text-gray-400">
											每帖最多 {attachmentLimits.MAX_ATTACHMENTS_PER_POST} 个附件，大文件将自动分块上传
										</span>
						<button
							type="button"
							onClick={startUpload}
										disabled={busy || selectedFiles.length === 0 || remainingSlots <= 0 || uploadsPaused}
										className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
									>
										{busy ? "上传中..." : "开始上传"}
									</button>
								</div>

									{queue.length > 0 ? (
										<ul className="mt-2 space-y-2">
											{queue.map((q) => (
												<li key={q.id} className="rounded bg-gray-50 px-3 py-2 text-sm dark:bg-gray-900/30">
												<div className="flex items-center justify-between gap-3">
													<span className="truncate text-gray-900 dark:text-gray-100">{q.file.name}</span>
													<span className="text-xs text-gray-500 dark:text-gray-400">{formatSize(q.file.size)}</span>
												</div>
												<div className="mt-2 h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
													<div
														className={q.status === "error" ? "h-2 bg-red-500" : "h-2 bg-blue-600"}
														style={{ width: `${Math.round(q.progress * 100)}%` }}
													/>
												</div>
												<div className="mt-1 flex items-center justify-between text-xs">
													<span className="text-gray-600 dark:text-gray-300">
														{q.status === "pending"
															? "等待上传"
															: q.status === "uploading"
																? "上传中"
																: q.status === "done"
																	? "已完成"
																	: "失败"}
													</span>
													<span className="text-gray-500 dark:text-gray-400">
														{Math.round(q.progress * 100)}%
													</span>
												</div>
												{q.error ? (
													<div className="mt-1 text-xs text-red-600 dark:text-red-300">{q.error}</div>
												) : null}
											</li>
											))}
										</ul>
									) : null}
								</div>
							</div>
						) : null}
					</section>
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
							评论（{data.commentCount}）
						</h2>
						{data.comments.length === 0 ? (
							<p className="text-sm text-gray-600 dark:text-gray-300">
								还没有任何评论。
							</p>
						) : (
							<ul className="space-y-4">
								{data.comments.map((comment, index) => (
									<li key={comment.id} className="border-b border-gray-200 pb-3 last:border-none last:pb-0 dark:border-gray-700">
										<div className="mb-1 flex items-center justify-between">
											<span className="text-xs text-gray-500 dark:text-gray-400">
												{commentStartIndex + index + 1} 楼
											</span>
											<span className="text-xs text-gray-500 dark:text-gray-400">
												{new Date(comment.createdAt).toLocaleString()}
											</span>
										</div>
										<div className="text-sm text-gray-800 dark:text-gray-100">
											{comment.content}
										</div>
										<p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
											<span>作者：{comment.authorName}</span>
										</p>
									</li>
								))}
							</ul>
						)}
						<div className="mt-6 flex items-center justify-between text-sm">
							<div className="text-gray-600 dark:text-gray-300">
								第 {data.page} / {data.totalPages} 页
							</div>
							<div className="flex items-center gap-3">
								{canPrev ? (
									<Link
										to={`?page=${data.page - 1}`}
										className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									>
										上一页
									</Link>
								) : (
									<span className="rounded border border-gray-200 px-3 py-1 text-gray-400 dark:border-gray-800 dark:text-gray-500">
										上一页
									</span>
								)}
								{canNext ? (
									<Link
										to={`?page=${data.page + 1}`}
										className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									>
										下一页
									</Link>
								) : (
									<span className="rounded border border-gray-200 px-3 py-1 text-gray-400 dark:border-gray-800 dark:text-gray-500">
										下一页
									</span>
								)}
							</div>
						</div>
					</section>
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
							发表评论
						</h2>
						{data.user ? (
							isBanned ? (
								<p className="text-sm text-gray-600 dark:text-gray-300">
									当前账号已被封禁，无法发表评论。
								</p>
							) : (
							<Form method="post" className="space-y-4">
								<input type="hidden" name="intent" value="comment" />
								<div>
									<textarea
										name="content"
										rows={4}
										className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
									/>
									{actionData?.fieldErrors?.content ? (
										<p className="mt-1 text-xs text-red-600">
											{actionData.fieldErrors.content}
										</p>
									) : null}
								</div>
								{actionData?.formError ? (
									<p className="text-sm text-red-600">{actionData.formError}</p>
								) : null}
								<div className="flex items-center justify-between">
									<span className="text-xs text-gray-500 dark:text-gray-400">
										当前第 {data.page} 页发表评论会刷新当前页
									</span>
									<button
										type="submit"
										disabled={isSubmitting}
										className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
									>
										{isSubmitting ? "提交中..." : "提交评论"}
									</button>
								</div>
							</Form>
							)
						) : (
							<p className="text-sm text-gray-600 dark:text-gray-300">
								登录后可以发表评论。
							</p>
						)}
					</section>
				</main>
			</div>
		</div>
	);
}
