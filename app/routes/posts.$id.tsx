import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getDBFromContext, queryAll, queryOne, execute } from "~/lib/d1.server";
import { getSession } from "~/lib/session.server";
import { assertNotBanned, findUserById, requireUser } from "~/lib/auth.server";
import {
	getAttachmentStorageUsage,
	listAttachmentsByPostId,
	listCommentAttachmentsByCommentIds,
	removeAllAttachmentsForPost,
	removeAllCommentAttachmentsForPost,
} from "~/lib/attachments.server";
import type { AttachmentRecord, CommentAttachmentRecord } from "~/lib/attachments.server";

const attachmentLimits = {
	MIN_FILE_SIZE_BYTES: 1024,
	MAX_FILE_SIZE_BYTES: 100 * 1024 * 1024,
	MAX_ATTACHMENTS_PER_POST: 3,
	MAX_TOTAL_POST_BYTES: 500 * 1024 * 1024,
	MAX_ATTACHMENTS_PER_COMMENT: 3,
	MAX_TOTAL_COMMENT_BYTES: 500 * 1024 * 1024,
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
	authorId: number;
	authorName: string;
	attachments: CommentAttachmentRecord[];
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
		"SELECT comments.id as id, comments.content as content, comments.created_at as createdAt, comments.author_id as authorId, users.display_name as authorName FROM comments JOIN users ON comments.author_id = users.id WHERE comments.post_id = ? ORDER BY comments.created_at ASC LIMIT ? OFFSET ?",
		[id, pageSize, offset],
	);

	const commentAttachmentRows = await listCommentAttachmentsByCommentIds(
		context,
		comments.map((c) => c.id),
	);
	const commentAttachmentMap = new Map<number, CommentAttachmentRecord[]>();
	for (const a of commentAttachmentRows) {
		const list = commentAttachmentMap.get(a.commentId) || [];
		list.push(a);
		commentAttachmentMap.set(a.commentId, list);
	}
	const commentsWithAttachments = comments.map((c) => ({
		...c,
		attachments: commentAttachmentMap.get(c.id) || [],
	}));

	const attachments = await listAttachmentsByPostId(context, id);
	const attachmentStorage = await getAttachmentStorageUsage(context);

	return json<LoaderData>({
		user,
		post,
		attachments,
		attachmentStorage,
		comments: commentsWithAttachments,
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
			await removeAllCommentAttachmentsForPost(context, postId);
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
	const [isDragging, setIsDragging] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	const remainingSlots = useMemo(() => {
		const existing = data.attachments.length;
		const uploading = queue.filter((q) => q.status === "pending" || q.status === "uploading").length;
		return Math.max(0, attachmentLimits.MAX_ATTACHMENTS_PER_POST - existing - uploading);
	}, [data.attachments.length, queue]);

	const existingBytes = useMemo(() => {
		return data.attachments.reduce((sum, a) => sum + (Number.isFinite(a.sizeBytes) ? a.sizeBytes : 0), 0);
	}, [data.attachments]);

	const uploadingBytes = useMemo(() => {
		return queue
			.filter((q) => q.status === "pending" || q.status === "uploading")
			.reduce((sum, q) => sum + (Number.isFinite(q.file.size) ? q.file.size : 0), 0);
	}, [queue]);

	const effectiveSelectedFiles = useMemo(() => {
		return selectedFiles.slice(0, remainingSlots);
	}, [remainingSlots, selectedFiles]);

	type SelectionSizeState = {
		selectedBytes: number;
		remainingBytes: number;
		overLimit: boolean;
	};

	const selectionSize = useMemo<SelectionSizeState>(() => {
		const selectedBytes = effectiveSelectedFiles.reduce(
			(sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0),
			0,
		);
		const remainingBytes = Math.max(0, attachmentLimits.MAX_TOTAL_POST_BYTES - existingBytes - uploadingBytes);
		return { selectedBytes, remainingBytes, overLimit: selectedBytes > remainingBytes };
	}, [effectiveSelectedFiles, existingBytes, uploadingBytes]);

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

	function isLikelyNetworkError(error: unknown) {
		if (!error) return false;
		if (error instanceof DOMException && error.name === "AbortError") return false;
		return error instanceof TypeError;
	}

	async function fetchWithRetry(
		input: RequestInfo | URL,
		init: RequestInit,
		options: { timeoutMs: number; retries: number },
	) {
		let lastError: unknown = null;
		for (let attempt = 1; attempt <= options.retries; attempt++) {
			const controller = new AbortController();
			const id = setTimeout(() => controller.abort(), options.timeoutMs);
			try {
				const res = await fetch(input, { ...init, signal: controller.signal });
				clearTimeout(id);
				return res;
			} catch (e) {
				clearTimeout(id);
				lastError = e;
				if (!isLikelyNetworkError(e) || attempt >= options.retries) break;
				await new Promise((r) => setTimeout(r, attempt * 300));
			}
		}
		throw lastError instanceof Error ? lastError : new Error("网络错误");
	}

	async function fetchJsonWithRetry<T>(
		input: RequestInfo | URL,
		init: RequestInit,
		options: { timeoutMs: number; retries: number },
	) {
		const res = await fetchWithRetry(input, init, options);
		let data: any = null;
		try {
			data = await res.json();
		} catch {
			data = null;
		}
		return { res, data: data as T };
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
			const { res, data } = await fetchJsonWithRetry<any>(
				`/api/attachments/${attachmentId}/token`,
				{ method: "GET" },
				{ timeoutMs: 15_000, retries: 3 },
			);
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "获取下载链接失败"));
			}
			const token = String(data.token || "");
			window.location.href = `/attachments/${attachmentId}?token=${encodeURIComponent(token)}`;
		} catch (e) {
			setGlobalError(e instanceof Error ? e.message : "获取下载链接失败");
		}
	}

	async function requestCommentDownload(commentAttachmentId: number) {
		setGlobalError(null);
		try {
			const { res, data } = await fetchJsonWithRetry<any>(
				`/api/comment-attachments/${commentAttachmentId}/token`,
				{ method: "GET" },
				{ timeoutMs: 15_000, retries: 3 },
			);
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "获取下载链接失败"));
			}
			const token = String(data.token || "");
			window.location.href = `/comment-attachments/${commentAttachmentId}?token=${encodeURIComponent(token)}`;
		} catch (e) {
			setGlobalError(e instanceof Error ? e.message : "获取下载链接失败");
		}
	}

	type CommentUploadState = {
		selectedFiles: File[];
		queue: UploadItem[];
		busy: boolean;
		error: string | null;
	};

	const [commentUploads, setCommentUploads] = useState<Record<number, CommentUploadState>>({});

	function updateCommentUploads(commentId: number, updater: (current: CommentUploadState) => CommentUploadState) {
		setCommentUploads((prev) => {
			const current = prev[commentId] || { selectedFiles: [], queue: [], busy: false, error: null };
			return { ...prev, [commentId]: updater(current) };
		});
	}

	async function initiateCommentUpload(commentId: number, file: File) {
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/comments/${commentId}/attachments/initiate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
			},
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!res.ok || !data?.ok) {
			throw new Error(String(data?.error || "创建上传任务失败"));
		}
		return data as {
			uploadRecordId: number;
			mode: "single" | "multipart";
			uploadId: string;
			partSizeBytes: number | null;
		};
	}

	async function listAlreadyUploadedCommentParts(uploadRecordId: number) {
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/comment-attachment-uploads/${uploadRecordId}/parts`,
			{ method: "GET" },
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!res.ok || !data?.ok || !Array.isArray(data?.parts)) {
			return new Set<number>();
		}
		return new Set<number>(data.parts.map((p: any) => Number(p)).filter((n: any) => Number.isFinite(n) && n > 0));
	}

	async function uploadCommentSingle(uploadRecordId: number, file: File) {
		const form = new FormData();
		form.append("file", file);
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/comment-attachment-uploads/${uploadRecordId}/upload`,
			{ method: "POST", body: form },
			{ timeoutMs: 300_000, retries: 3 },
		);
		if (!res.ok || !data?.ok) {
			throw new Error(String(data?.error || "上传失败"));
		}
	}

	async function uploadCommentMultipart(uploadRecordId: number, file: File, partSizeBytes: number, onProgress: (p: number) => void) {
		const totalParts = Math.ceil(file.size / partSizeBytes);
		const already = await listAlreadyUploadedCommentParts(uploadRecordId);
		let completed = 0;
		for (let i = 1; i <= totalParts; i++) {
			if (already.has(i)) completed++;
		}
		onProgress(totalParts > 0 ? completed / totalParts : 0);
		for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
			if (already.has(partNumber)) continue;
			const start = (partNumber - 1) * partSizeBytes;
			const end = Math.min(file.size, partNumber * partSizeBytes);
			const chunk = file.slice(start, end);
			const body = await chunk.arrayBuffer();
			const { res, data } = await fetchJsonWithRetry<any>(
				`/api/comment-attachment-uploads/${uploadRecordId}/parts/${partNumber}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body,
				},
				{ timeoutMs: 300_000, retries: 3 },
			);
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "上传分块失败"));
			}
			completed++;
			onProgress(totalParts > 0 ? completed / totalParts : 0);
		}
		const { res: doneRes, data: done } = await fetchJsonWithRetry<any>(
			`/api/comment-attachment-uploads/${uploadRecordId}/complete`,
			{ method: "POST" },
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!doneRes.ok || !done?.ok) {
			throw new Error(String(done?.error || "完成上传失败"));
		}
	}

	async function startCommentUpload(commentId: number, existingAttachments: CommentAttachmentRecord[]) {
		const current = commentUploads[commentId] || { selectedFiles: [], queue: [], busy: false, error: null };
		if (current.busy) return;
		const uploadingCount = current.queue.filter((q) => q.status === "pending" || q.status === "uploading").length;
		const remainingSlots = Math.max(0, attachmentLimits.MAX_ATTACHMENTS_PER_COMMENT - existingAttachments.length - uploadingCount);
		if (remainingSlots <= 0) {
			updateCommentUploads(commentId, (c) => ({ ...c, error: "该评论附件数量已达上限" }));
			return;
		}
		if (current.selectedFiles.length === 0) {
			updateCommentUploads(commentId, (c) => ({ ...c, error: "请选择要上传的文件" }));
			return;
		}
		const existingBytes = existingAttachments.reduce((sum, a) => sum + (Number.isFinite(a.sizeBytes) ? a.sizeBytes : 0), 0);
		const uploadingBytes = current.queue
			.filter((q) => q.status === "pending" || q.status === "uploading")
			.reduce((sum, q) => sum + (Number.isFinite(q.file.size) ? q.file.size : 0), 0);
		const files = current.selectedFiles.slice(0, remainingSlots);
		const selectedBytes = files.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0);
		if (existingBytes + uploadingBytes + selectedBytes > attachmentLimits.MAX_TOTAL_COMMENT_BYTES) {
			updateCommentUploads(commentId, (c) => ({ ...c, error: "已超出单条评论附件总大小上限（500MB）" }));
			return;
		}

		const items: UploadItem[] = files.map((file) => ({
			id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
			file,
			status: "pending",
			progress: 0,
			error: null,
		}));
		updateCommentUploads(commentId, (c) => ({ ...c, queue: items, busy: true, error: null }));
		for (const item of items) {
			updateCommentUploads(commentId, (c) => ({
				...c,
				queue: c.queue.map((q) => (q.id === item.id ? { ...q, status: "uploading", progress: 0, error: null } : q)),
			}));
			try {
				const localError = validateLocal(item.file);
				if (localError) {
					throw new Error(localError);
				}
				const init = await initiateCommentUpload(commentId, item.file);
				if (init.mode === "single") {
					await uploadCommentSingle(init.uploadRecordId, item.file);
					updateCommentUploads(commentId, (c) => ({
						...c,
						queue: c.queue.map((q) => (q.id === item.id ? { ...q, progress: 1 } : q)),
					}));
				} else {
					const partSize = init.partSizeBytes || attachmentLimits.PART_SIZE_BYTES;
					await uploadCommentMultipart(init.uploadRecordId, item.file, partSize, (p) => {
						updateCommentUploads(commentId, (c) => ({
							...c,
							queue: c.queue.map((q) => (q.id === item.id ? { ...q, progress: p } : q)),
						}));
					});
				}
				updateCommentUploads(commentId, (c) => ({
					...c,
					queue: c.queue.map((q) => (q.id === item.id ? { ...q, status: "done", progress: 1 } : q)),
				}));
			} catch (e) {
				const message = e instanceof Error ? e.message : "上传失败";
				updateCommentUploads(commentId, (c) => ({
					...c,
					queue: c.queue.map((q) => (q.id === item.id ? { ...q, status: "error", error: message } : q)),
				}));
			}
		}
		updateCommentUploads(commentId, (c) => ({ ...c, busy: false, selectedFiles: [] }));
		window.location.reload();
	}

	async function initiateUpload(postId: number, file: File) {
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/posts/${postId}/attachments/initiate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
			},
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!res.ok || !data?.ok) {
			throw new Error(String(data?.error || "创建上传任务失败"));
		}
		return data as {
			uploadRecordId: number;
			mode: "single" | "multipart";
			uploadId: string;
			partSizeBytes: number | null;
		};
	}

	async function listAlreadyUploadedParts(uploadRecordId: number) {
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/attachment-uploads/${uploadRecordId}/parts`,
			{ method: "GET" },
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!res.ok || !data?.ok || !Array.isArray(data?.parts)) {
			return new Set<number>();
		}
		return new Set<number>(data.parts.map((p: any) => Number(p)).filter((n: any) => Number.isFinite(n) && n > 0));
	}

	async function uploadSingle(uploadRecordId: number, file: File) {
		const form = new FormData();
		form.append("file", file);
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/attachment-uploads/${uploadRecordId}/upload`,
			{ method: "POST", body: form },
			{ timeoutMs: 300_000, retries: 3 },
		);
		if (!res.ok || !data?.ok) {
			throw new Error(String(data?.error || "上传失败"));
		}
	}

	async function uploadMultipart(uploadRecordId: number, file: File, partSizeBytes: number, onProgress: (p: number) => void) {
		const totalParts = Math.ceil(file.size / partSizeBytes);
		const already = await listAlreadyUploadedParts(uploadRecordId);
		let completed = 0;
		for (let i = 1; i <= totalParts; i++) {
			if (already.has(i)) completed++;
		}
		onProgress(totalParts > 0 ? completed / totalParts : 0);
		for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
			if (already.has(partNumber)) {
				continue;
			}
			const start = (partNumber - 1) * partSizeBytes;
			const end = Math.min(file.size, partNumber * partSizeBytes);
			const chunk = file.slice(start, end);
			const body = await chunk.arrayBuffer();
			const { res, data } = await fetchJsonWithRetry<any>(
				`/api/attachment-uploads/${uploadRecordId}/parts/${partNumber}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body,
				},
				{ timeoutMs: 300_000, retries: 3 },
			);
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "上传分块失败"));
			}
			completed++;
			onProgress(totalParts > 0 ? completed / totalParts : 0);
		}
		const { res: doneRes, data: done } = await fetchJsonWithRetry<any>(
			`/api/attachment-uploads/${uploadRecordId}/complete`,
			{ method: "POST" },
			{ timeoutMs: 15_000, retries: 3 },
		);
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
		if (selectionSize.overLimit) {
			setGlobalError("已超出单帖附件总大小上限（500MB）");
			return;
		}
		if (remainingSlots <= 0) {
			setGlobalError("该帖子附件数量已达上限");
			return;
		}
		const files = effectiveSelectedFiles;
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
								<div className="flex items-center justify-between gap-3">
									<div className="min-w-0">
										<label className="text-sm font-medium text-gray-900 dark:text-gray-100">
											上传附件
										</label>
										<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
											<span>剩余可上传：{remainingSlots} 个</span>
											<span>
												已选 {formatSize(selectionSize.selectedBytes)} / 剩余 {formatSize(selectionSize.remainingBytes)}
											</span>
											{selectedFiles.length > remainingSlots ? (
												<span className="text-amber-700 dark:text-amber-300">
													已选择 {selectedFiles.length} 个，仅上传前 {remainingSlots} 个
												</span>
											) : null}
											{selectionSize.overLimit ? (
												<span className="text-red-600 dark:text-red-300">已超出 500MB 上限</span>
											) : null}
										</div>
									</div>
									<button
										type="button"
										onClick={() => fileInputRef.current?.click()}
										disabled={busy || remainingSlots <= 0 || uploadsPaused}
										className={
											busy || remainingSlots <= 0 || uploadsPaused
												? "h-9 w-12 cursor-not-allowed rounded bg-gray-300 text-[10px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200"
												: "h-9 w-12 rounded bg-gradient-to-r from-blue-600 to-cyan-500 text-[10px] font-semibold text-white shadow hover:from-blue-700 hover:to-cyan-600"
										}
									>
										<span className="block leading-3">
											上传
											<br />
											附件
										</span>
									</button>
								</div>
								{uploadsPaused ? (
									<div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
										网站总存储量已超过 9GB，已暂停附件上传
									</div>
								) : null}
							<input
								ref={fileInputRef}
								type="file"
								multiple
								disabled={busy || remainingSlots <= 0 || uploadsPaused}
								onChange={(e) => {
									const files = Array.from(e.target.files || []);
									setSelectedFiles(files);
									e.currentTarget.value = "";
								}}
								className="hidden"
							/>
							<div
								onDragEnter={(e) => {
									e.preventDefault();
								if (busy || remainingSlots <= 0 || uploadsPaused) return;
								setIsDragging(true);
							}}
								onDragOver={(e) => {
									e.preventDefault();
								if (busy || remainingSlots <= 0 || uploadsPaused) return;
								setIsDragging(true);
							}}
								onDragLeave={(e) => {
									e.preventDefault();
								setIsDragging(false);
							}}
								onDrop={(e) => {
									e.preventDefault();
								setIsDragging(false);
								if (busy || remainingSlots <= 0 || uploadsPaused) return;
								const files = Array.from(e.dataTransfer.files || []);
								setSelectedFiles(files);
							}}
							className={
								busy || remainingSlots <= 0 || uploadsPaused
									? "rounded-lg border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-400 dark:border-gray-800 dark:bg-gray-900/30 dark:text-gray-500"
									: isDragging
										? "cursor-pointer rounded-lg border border-dashed border-blue-400 bg-blue-50 p-4 text-sm text-blue-700 dark:border-blue-600 dark:bg-blue-900/20 dark:text-blue-200"
										: "cursor-pointer rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-700 hover:border-blue-400 hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-200 dark:hover:border-blue-600 dark:hover:bg-blue-900/20"
							}
							onClick={() => {
								if (busy || remainingSlots <= 0 || uploadsPaused) return;
								fileInputRef.current?.click();
							}}
							role="button"
							tabIndex={0}
							onKeyDown={(e) => {
								if (e.key !== "Enter" && e.key !== " ") return;
								e.preventDefault();
								if (busy || remainingSlots <= 0 || uploadsPaused) return;
								fileInputRef.current?.click();
							}}
						>
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="font-medium">
										拖拽文件到此处，或点击选择文件
									</div>
									<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
										单帖总大小上限 500MB；大文件将自动分块上传
									</div>
								</div>
								<div className="text-xs text-gray-500 dark:text-gray-400">
									{formatSize(attachmentLimits.MIN_FILE_SIZE_BYTES)}~{formatSize(attachmentLimits.MAX_FILE_SIZE_BYTES)}
								</div>
							</div>
							{effectiveSelectedFiles.length > 0 ? (
								<ul className="mt-3 space-y-1 text-xs text-gray-700 dark:text-gray-200">
									{effectiveSelectedFiles.map((f) => (
										<li key={f.name} className="flex items-center justify-between gap-3">
											<span className="min-w-0 truncate">{f.name}</span>
											<span className="shrink-0 text-gray-500 dark:text-gray-400">{formatSize(f.size)}</span>
										</li>
									))}
								</ul>
							) : null}
						</div>
								<div className="flex items-center justify-between">
									<span className="text-xs text-gray-500 dark:text-gray-400">
										每帖最多 {attachmentLimits.MAX_ATTACHMENTS_PER_POST} 个附件
									</span>
									<button
										type="button"
										onClick={startUpload}
										disabled={busy || effectiveSelectedFiles.length === 0 || remainingSlots <= 0 || uploadsPaused || selectionSize.overLimit}
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
										{comment.attachments.length === 0 ? null : (
											<ul className="mt-3 space-y-2">
												{comment.attachments.map((a) => (
													<li
														key={a.id}
														className="flex items-center justify-between gap-3 rounded border border-gray-200 px-3 py-2 text-xs dark:border-gray-700"
													>
														<div className="min-w-0">
															<div className="truncate font-medium text-gray-900 dark:text-gray-100">{a.filename}</div>
															<div className="text-[11px] text-gray-500 dark:text-gray-400">
																{formatSize(a.sizeBytes)} · {new Date(a.createdAt).toLocaleString()}
															</div>
														</div>
														{data.user ? (
															<button
																type="button"
																onClick={() => requestCommentDownload(a.id)}
																disabled={isBanned}
																className={
																	isBanned
																		? "cursor-not-allowed rounded bg-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
																	: "rounded bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
																}
															>
																下载
															</button>
														) : (
															<a
																href="/login"
																className="rounded bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
															>
																登录后下载
															</a>
														)}
													</li>
												))}
											</ul>
										)}

										{data.user && data.user.id === comment.authorId && !isBanned ? (
											<div className="mt-3 rounded border border-gray-200 p-3 dark:border-gray-700">
												<div className="flex items-center justify-between gap-3">
													<div className="min-w-0">
														<div className="text-sm font-medium text-gray-900 dark:text-gray-100">上传评论附件</div>
														<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
															剩余可上传：
															{Math.max(
																0,
																attachmentLimits.MAX_ATTACHMENTS_PER_COMMENT -
																	comment.attachments.length -
																	(commentUploads[comment.id]?.queue.filter((q) => q.status === "pending" || q.status === "uploading")
																		.length || 0),
															)}
															个；单条评论总大小上限 500MB
														</div>
													</div>
													<button
														type="button"
														onClick={() => startCommentUpload(comment.id, comment.attachments)}
														disabled={Boolean(commentUploads[comment.id]?.busy)}
														className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-70"
													>
														{commentUploads[comment.id]?.busy ? "上传中..." : "开始上传"}
													</button>
												</div>
												<div className="mt-2 flex items-center justify-between gap-3">
													<input
														type="file"
														multiple
														disabled={Boolean(commentUploads[comment.id]?.busy)}
														onChange={(e) => {
															const files = Array.from(e.target.files || []);
															updateCommentUploads(comment.id, (c) => ({ ...c, selectedFiles: files, error: null }));
															e.currentTarget.value = "";
														}}
														className="block w-full text-xs text-gray-700 file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1 file:text-xs file:font-medium file:text-gray-900 hover:file:bg-gray-200 dark:text-gray-200 dark:file:bg-gray-800 dark:file:text-gray-100 dark:hover:file:bg-gray-700"
													/>
												</div>
												{commentUploads[comment.id]?.error ? (
													<div className="mt-2 text-xs text-red-600 dark:text-red-300">{commentUploads[comment.id]?.error}</div>
												) : null}
												{commentUploads[comment.id]?.queue?.length ? (
													<ul className="mt-2 space-y-2">
														{commentUploads[comment.id].queue.map((q) => (
															<li key={q.id} className="rounded bg-gray-50 px-3 py-2 text-xs dark:bg-gray-900/30">
																<div className="flex items-center justify-between gap-3">
																	<span className="min-w-0 truncate text-gray-900 dark:text-gray-100">{q.file.name}</span>
																	<span className="shrink-0 text-gray-500 dark:text-gray-400">{formatSize(q.file.size)}</span>
																</div>
																<div className="mt-2 h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
																	<div
																		className={q.status === "error" ? "h-2 bg-red-500" : "h-2 bg-blue-600"}
																		style={{ width: `${Math.round(q.progress * 100)}%` }}
																	/>
																</div>
																<div className="mt-1 flex items-center justify-between text-[11px]">
																	<span className="text-gray-600 dark:text-gray-300">
																		{q.status === "pending"
																			? "等待上传"
																			: q.status === "uploading"
																				? "上传中"
																				: q.status === "done"
																					? "已完成"
																					: "失败"}
																	</span>
																	<span className="text-gray-500 dark:text-gray-400">{Math.round(q.progress * 100)}%</span>
																</div>
																{q.error ? <div className="mt-1 text-xs text-red-600 dark:text-red-300">{q.error}</div> : null}
															</li>
														))}
													</ul>
												) : null}
											</div>
										) : null}
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
