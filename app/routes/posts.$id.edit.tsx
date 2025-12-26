import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import {
	Form,
	Link,
	isRouteErrorResponse,
	useActionData,
	useLoaderData,
	useLocation,
	useNavigation,
	useRouteError,
} from "@remix-run/react";
import type { ChangeEvent } from "react";
import { useMemo, useRef, useState } from "react";
import { assertNotBanned, getClientIp, requireUser } from "~/lib/auth.server";
import { getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";

type AreaListItem = {
	id: number;
	name: string;
	isHidden: number;
};

type PostRow = {
	id: number;
	title: string;
	content: string;
	authorId: number;
	createdAt: number;
	updatedAt: number | null;
	updatedBy: number | null;
	areaId: number;
	isBanned: number;
	bannedReason: string | null;
};

type LoaderData = {
	me: { id: number; role: string; displayName: string };
	post: PostRow;
	areas: AreaListItem[];
};

type ActionData = {
	fields?: {
		areaId?: string;
		title?: string;
		content?: string;
		confirm?: string;
	};
	fieldErrors?: {
		areaId?: string;
		title?: string;
		content?: string;
		confirm?: string;
	};
	formError?: string;
};

function parseId(value: unknown) {
	const num = typeof value === "number" ? value : Number(String(value || "").trim());
	if (!Number.isFinite(num) || num <= 0) return null;
	return Math.floor(num);
}

function normalizeText(input: string) {
	return String(input || "").replace(/\u0000/g, "");
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	const rawId = params.id;
	const postId = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(postId)) {
		throw new Response("无效的帖子ID", { status: 400 });
	}
	const db = getDBFromContext(context);
	let post: PostRow | null = null;
	try {
		post = await queryOne<PostRow>(
			db,
			"SELECT id as id, title as title, content as content, author_id as authorId, created_at as createdAt, updated_at as updatedAt, updated_by as updatedBy, area_id as areaId, is_banned as isBanned, banned_reason as bannedReason FROM posts WHERE id = ? AND deleted_at IS NULL",
			[postId],
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such column") && message.includes("updated_by")) {
			post = await queryOne<PostRow>(
				db,
				"SELECT id as id, title as title, content as content, author_id as authorId, created_at as createdAt, updated_at as updatedAt, NULL as updatedBy, area_id as areaId, is_banned as isBanned, banned_reason as bannedReason FROM posts WHERE id = ? AND deleted_at IS NULL",
				[postId],
			);
		} else {
			throw error;
		}
	}
	if (!post) {
		throw new Response("帖子不存在", { status: 404 });
	}

	const canEditAny = me.role === "superadmin" || me.role === "topadmin";
	const canEdit = canEditAny || me.id === post.authorId;
	if (!canEdit) {
		throw new Response("无权编辑该帖子", { status: 403 });
	}
	if (post.isBanned && !canEditAny) {
		throw new Response("该帖子已被封禁，禁止编辑", { status: 403 });
	}

	const canSeeHidden = canEditAny;
	const areas = await queryAll<AreaListItem>(
		db,
		canSeeHidden
			? "SELECT id as id, name as name, is_hidden as isHidden FROM discussion_areas ORDER BY sort_order ASC, id ASC"
			: "SELECT id as id, name as name, is_hidden as isHidden FROM discussion_areas WHERE is_hidden = 0 ORDER BY sort_order ASC, id ASC",
	);
	return json<LoaderData>({ me: { id: me.id, role: me.role, displayName: me.displayName }, post, areas });
}

export async function action({ request, context, params }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	const rawId = params.id;
	const postId = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(postId)) {
		return json<ActionData>({ formError: "无效的帖子ID" }, { status: 400 });
	}

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return json<ActionData>({ formError: "请求格式错误" }, { status: 400 });
	}

	const title = normalizeText(String(formData.get("title") || ""));
	const content = normalizeText(String(formData.get("content") || ""));
	const areaIdRaw = String(formData.get("areaId") || "").trim();
	const confirm = String(formData.get("confirm") || "").trim();
	const trimmedTitle = title.trim();
	const trimmedContent = content.trim();
	const areaId = parseId(areaIdRaw);
	const fields: ActionData["fields"] = { areaId: areaIdRaw, title, content, confirm };
	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!areaId) {
		fieldErrors.areaId = "请选择讨论区";
	}
	if (!trimmedTitle) {
		fieldErrors.title = "请输入标题";
	}
	if (!trimmedContent) {
		fieldErrors.content = "请输入内容";
	}
	if (fieldErrors.areaId || fieldErrors.title || fieldErrors.content) {
		return json<ActionData>({ fields, fieldErrors }, { status: 400 });
	}

	const db = getDBFromContext(context);
	const post = await queryOne<{ authorId: number; title: string; content: string; areaId: number; isBanned: number }>(
		db,
		"SELECT author_id as authorId, title as title, content as content, area_id as areaId, is_banned as isBanned FROM posts WHERE id = ? AND deleted_at IS NULL",
		[postId],
	);
	if (!post) {
		return json<ActionData>({ formError: "帖子不存在" }, { status: 404 });
	}

	const canEditAny = me.role === "superadmin" || me.role === "topadmin";
	const canEdit = canEditAny || me.id === post.authorId;
	if (!canEdit) {
		return json<ActionData>({ formError: "无权编辑该帖子" }, { status: 403 });
	}
	if (post.isBanned && !canEditAny) {
		return json<ActionData>({ formError: "该帖子已被封禁，禁止编辑" }, { status: 403 });
	}

	const area = await queryOne<{ id: number; isHidden: number }>(
		db,
		"SELECT id as id, is_hidden as isHidden FROM discussion_areas WHERE id = ?",
		[areaId],
	);
	if (!area) {
		return json<ActionData>({ fields, formError: "讨论区不存在" }, { status: 400 });
	}
	if (area.isHidden && !canEditAny) {
		return json<ActionData>({ fields, formError: "该讨论区已隐藏，无法移动帖子" }, { status: 403 });
	}

	const changedTitle = post.title !== trimmedTitle;
	const changedContent = post.content !== trimmedContent;
	const changedArea = post.areaId !== area.id;
	const changed = changedTitle || changedContent || changedArea;
	if (!changed) {
		return json<ActionData>({ fields, formError: "未做任何修改" }, { status: 400 });
	}
	if (confirm !== "1") {
		fieldErrors.confirm = "需要二次确认";
		return json<ActionData>({ fields, fieldErrors }, { status: 400 });
	}

	const now = Date.now();
	const ip = getClientIp(request);
	const userAgent = request.headers.get("User-Agent");

	try {
		const stmts = [
			db
				.prepare(
					"INSERT INTO post_edits (post_id, editor_id, created_at, old_title, old_content, old_area_id, new_title, new_content, new_area_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					postId,
					me.id,
					now,
					post.title,
					post.content,
					post.areaId,
					trimmedTitle,
					trimmedContent,
					area.id,
				),
			db
				.prepare("UPDATE posts SET title = ?, content = ?, area_id = ?, updated_at = ?, updated_by = ? WHERE id = ?")
				.bind(trimmedTitle, trimmedContent, area.id, now, me.id, postId),
			db
				.prepare(
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.bind(
					me.id,
					"post_edited",
					ip,
					userAgent,
					JSON.stringify({
						postId,
						postAuthorId: post.authorId,
						changedTitle,
						changedContent,
						changedArea,
						fromAreaId: post.areaId,
						toAreaId: area.id,
					}),
					now,
				),
		];
		await (db as any).batch(stmts);
		return redirect(`/posts/${postId}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such table") || message.includes("no such column")) {
			return json<ActionData>({ fields, formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
		}
		return json<ActionData>({ fields, formError: "保存失败，请稍后重试" }, { status: 500 });
	}
}

export default function EditPostPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [imageUploading, setImageUploading] = useState(false);
	const [imageError, setImageError] = useState<string | null>(null);

	const fallbackAreaId = data.areas.length > 0 ? String(data.areas[0].id) : "";
	const selectedAreaId =
		actionData?.fields?.areaId && actionData.fields.areaId !== "" ? actionData.fields.areaId : String(data.post.areaId || fallbackAreaId);

	const lastModifiedText = useMemo(() => {
		if (!data.post.updatedAt) return "暂无";
		return new Date(data.post.updatedAt).toLocaleString();
	}, [data.post.updatedAt]);

	function insertAtCursor(text: string) {
		const el = textareaRef.current;
		if (!el) return;
		const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
		const end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
		const before = el.value.slice(0, start);
		const after = el.value.slice(end);
		el.value = `${before}${text}${after}`;
		const next = start + text.length;
		try {
			el.setSelectionRange(next, next);
		} catch {
		}
		try {
			el.dispatchEvent(new Event("input", { bubbles: true }));
		} catch {
		}
		el.focus();
	}

	async function fetchJson(url: string, init: RequestInit) {
		const res = await fetch(url, init);
		let data: any = null;
		try {
			data = await res.json();
		} catch {
			data = null;
		}
		return { res, data };
	}

	function validateLocalImage(file: File) {
		const maxBytes = 5 * 1024 * 1024;
		if (!file) return "缺少文件";
		if (file.size <= 0) return "缺少文件内容";
		if (file.size > maxBytes) return "单张图片大小不能超过 5MB";
		const name = String(file.name || "").toLowerCase();
		const idx = name.lastIndexOf(".");
		const ext = idx > 0 ? name.slice(idx + 1) : "";
		const allowed = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
		if (!allowed.has(ext)) return "仅支持 JPG、PNG、GIF、WebP 图片";
		return null;
	}

	async function initiatePostImageUpload(file: File) {
		const { res, data: payload } = await fetchJson(`/api/posts/${data.post.id}/images/initiate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
		});
		if (!res.ok || !payload?.ok) {
			throw new Error(String(payload?.error || "创建上传任务失败"));
		}
		return payload as { uploadRecordId: number; mode: "single" | "multipart"; partSizeBytes: number | null };
	}

	async function listUploadedParts(uploadRecordId: number) {
		const { res, data: payload } = await fetchJson(`/api/post-image-uploads/${uploadRecordId}/parts`, { method: "GET" });
		if (!res.ok || !payload?.ok || !Array.isArray(payload?.parts)) {
			return new Set<number>();
		}
		return new Set<number>(payload.parts.map((p: any) => Number(p)).filter((n: any) => Number.isFinite(n) && n > 0));
	}

	async function uploadSingle(uploadRecordId: number, file: File) {
		const form = new FormData();
		form.append("file", file);
		const { res, data: payload } = await fetchJson(`/api/post-image-uploads/${uploadRecordId}/upload`, { method: "POST", body: form });
		if (!res.ok || !payload?.ok) {
			throw new Error(String(payload?.error || "上传失败"));
		}
		return Number(payload.imageId);
	}

	async function uploadMultipart(uploadRecordId: number, file: File, partSizeBytes: number) {
		const totalParts = Math.ceil(file.size / partSizeBytes);
		const already = await listUploadedParts(uploadRecordId);
		for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
			if (already.has(partNumber)) continue;
			const start = (partNumber - 1) * partSizeBytes;
			const end = Math.min(file.size, partNumber * partSizeBytes);
			const chunk = file.slice(start, end);
			const body = await chunk.arrayBuffer();
			const { res, data: payload } = await fetchJson(`/api/post-image-uploads/${uploadRecordId}/parts/${partNumber}`, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body,
			});
			if (!res.ok || !payload?.ok) {
				throw new Error(String(payload?.error || "上传分块失败"));
			}
		}
		const { res: doneRes, data: done } = await fetchJson(`/api/post-image-uploads/${uploadRecordId}/complete`, {
			method: "POST",
		});
		if (!doneRes.ok || !done?.ok) {
			throw new Error(String(done?.error || "完成上传失败"));
		}
		return Number(done.imageId);
	}

	async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0] || null;
		e.target.value = "";
		if (!file) return;
		setImageError(null);
		const localErr = validateLocalImage(file);
		if (localErr) {
			setImageError(localErr);
			return;
		}
		setImageUploading(true);
		try {
			const init = await initiatePostImageUpload(file);
			const partSize = init.partSizeBytes || 1024 * 1024;
			const imageId = init.mode === "single" ? await uploadSingle(init.uploadRecordId, file) : await uploadMultipart(init.uploadRecordId, file, partSize);
			insertAtCursor(`[[img:${imageId}]]`);
		} catch (err) {
			const message = err instanceof Error ? err.message : "插图上传失败";
			setImageError(message || "插图上传失败");
		} finally {
			setImageUploading(false);
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="w-full max-w-2xl rounded-xl bg-white p-8 shadow dark:bg-gray-800">
				<h1 className="mb-2 text-center text-2xl font-semibold text-gray-900 dark:text-gray-100">编辑帖子</h1>
				<p className="mb-6 text-center text-xs text-gray-500 dark:text-gray-400">最后修改：{lastModifiedText}</p>
				<Form method="post" className="space-y-5">
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">讨论区</label>
						<select
							name="areaId"
							required
							defaultValue={selectedAreaId}
							className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						>
							<option value="" disabled>
								请选择讨论区
							</option>
							{data.areas.map((a) => (
								<option key={a.id} value={a.id}>
									{a.name}{a.isHidden ? "（隐藏）" : ""}
								</option>
							))}
						</select>
						{actionData?.fieldErrors?.areaId ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.areaId}</p>
						) : null}
					</div>
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">标题</label>
						<input
							name="title"
							required
							defaultValue={actionData?.fields?.title ?? data.post.title}
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.title ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.title}</p>
						) : null}
					</div>
					<div>
						<div className="mb-1 flex items-center justify-between gap-3">
							<label className="block text-sm font-medium text-gray-700 dark:text-gray-200">内容</label>
							<div className="flex items-center gap-2">
								<input
									ref={fileInputRef}
									type="file"
									accept="image/jpeg,image/png,image/gif,image/webp"
									onChange={onPickImage}
									className="hidden"
								/>
								<button
									type="button"
									onClick={() => fileInputRef.current?.click()}
									disabled={isSubmitting || imageUploading}
									className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-70 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
								>
									{imageUploading ? "上传中..." : "插入图片"}
								</button>
							</div>
						</div>
						<textarea
							ref={textareaRef}
							name="content"
							rows={10}
							required
							defaultValue={actionData?.fields?.content ?? data.post.content}
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{imageError ? <p className="mt-1 text-xs text-red-600">{imageError}</p> : null}
						{actionData?.fieldErrors?.content ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.content}</p>
						) : null}
					</div>
					<div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
						<label className="flex items-center gap-2">
							<input
								name="confirm"
								value="1"
								type="checkbox"
								aria-label="我已确认本次修改将立即生效，并记录到修改历史"
								defaultChecked={actionData?.fields?.confirm === "1"}
								className="h-4 w-4 rounded border-gray-300 text-amber-600"
							/>
							<span>我已确认本次修改将立即生效，并记录到修改历史</span>
						</label>
						{actionData?.fieldErrors?.confirm ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.confirm}</p>
						) : null}
					</div>
					{actionData?.formError ? <p className="text-sm text-red-600">{actionData.formError}</p> : null}
					<div className="flex items-center justify-between">
						<Link to={`/posts/${data.post.id}`} className="text-sm text-gray-600 hover:underline dark:text-gray-300">
							取消
						</Link>
						<button
							type="submit"
							disabled={isSubmitting}
							className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
						>
							{isSubmitting ? "保存中..." : "保存"}
						</button>
					</div>
				</Form>
			</div>
		</div>
	);
}

export function ErrorBoundary() {
	const error = useRouteError();
	const location = useLocation();
	let message = "页面加载失败，请稍后重试";
	let status: number | null = null;
	if (isRouteErrorResponse(error)) {
		status = error.status;
		message = String(error.data || error.statusText || message);
	} else if (error instanceof Error) {
		message = error.message || message;
	}

	const match = location.pathname.match(/^\/posts\/(\d+)\/edit/);
	const fallbackTo = match ? `/posts/${match[1]}` : "/posts";
	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-3xl flex-col gap-4">
				<div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 shadow dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
					<div className="font-medium">{status ? `错误 ${status}` : "错误"}</div>
					<div className="mt-2 break-words">{message}</div>
					<div className="mt-4 flex flex-wrap items-center gap-3">
						<Link
							to={`${location.pathname}${location.search}`}
							prefetch="intent"
							className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
						>
							重试
						</Link>
						<Link to={fallbackTo} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
							返回
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}
