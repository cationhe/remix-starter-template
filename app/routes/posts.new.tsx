import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";
import { assertNotBanned, consumeDailyQuota, getClientIp, requireUser } from "~/lib/auth.server";
import { canPostInDiscussionArea, getEffectiveDiscussionPermissionsForAreas, isDiscussionPermissionsReady } from "~/lib/discussion-permissions.server";
import { associateDraftImagesToPost } from "~/lib/post-images.server";
import { splitPostContentParts } from "~/lib/post-content";

type AreaListItem = {
	id: number;
	name: string;
	isHidden: number;
};

type LoaderData = {
	me: { id: number; role: string };
	areas: AreaListItem[];
	lockedAreaId: number | null;
};

type ActionData = {
	fields?: {
		areaId?: string;
		title?: string;
		content?: string;
	};
	fieldErrors?: {
		areaId?: string;
		title?: string;
		content?: string;
	};
	formError?: string;
};

export async function loader({ request, context }: LoaderFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);
	const db = getDBFromContext(context);
	const canSeeHidden = user.role === "superadmin" || user.role === "topadmin";
	const url = new URL(request.url);
	const lockedRaw = String(url.searchParams.get("areaId") ?? "").trim();
	const lockedAreaIdNum = (() => {
		if (!lockedRaw) return null;
		const n = Number(lockedRaw);
		if (!Number.isFinite(n) || n <= 0) return null;
		return Math.floor(n);
	})();
	let areas = await queryAll<AreaListItem>(
		db,
		canSeeHidden
			? "SELECT id as id, name as name, is_hidden as isHidden FROM discussion_areas ORDER BY sort_order ASC, id ASC"
			: "SELECT id as id, name as name, is_hidden as isHidden FROM discussion_areas WHERE is_hidden = 0 ORDER BY sort_order ASC, id ASC",
	);
	const permissionReady = await isDiscussionPermissionsReady(context);
	if (permissionReady) {
		const permMap = await getEffectiveDiscussionPermissionsForAreas(context, areas.map((a) => a.id), user.role);
		areas = areas.filter((a) => permMap[a.id]?.canView);
	}
	if (lockedAreaIdNum) {
		const target = areas.find((a) => a.id === lockedAreaIdNum) ?? null;
		if (!target) {
			throw new Response("讨论区不存在", { status: 404 });
		}
		areas = [target];
		return json<LoaderData>({ me: { id: user.id, role: user.role }, areas, lockedAreaId: target.id });
	}
	return json<LoaderData>({ me: { id: user.id, role: user.role }, areas, lockedAreaId: null });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);
	const url = new URL(request.url);
	const lockedRaw = String(url.searchParams.get("areaId") ?? "").trim();
	const lockedAreaIdNum = (() => {
		if (!lockedRaw) return null;
		const n = Number(lockedRaw);
		if (!Number.isFinite(n) || n <= 0) return null;
		return Math.floor(n);
	})();
	const formData = await request.formData();
	const title = String(formData.get("title") || "");
	const content = String(formData.get("content") || "");
	const draftId = String(formData.get("draftId") || "").trim();
	const areaIdRawFromForm = String(formData.get("areaId") || "").trim();
	const areaIdRaw = lockedAreaIdNum ? String(lockedAreaIdNum) : areaIdRawFromForm;
	const trimmedTitle = title.trim();
	const trimmedContent = content.trim();
	const wantsHiddenPost = String(formData.get("isHiddenPost") || "").trim() === "1";
	if (wantsHiddenPost && user.role !== "topadmin") {
		return json<ActionData>({ fields: { areaId: areaIdRaw, title, content }, formError: "只有站点管理员可以创建隐藏帖子" }, { status: 403 });
	}
	const areaId = Number(areaIdRaw);
	const fields: ActionData["fields"] = {
		areaId: areaIdRaw,
		title,
		content,
	};
	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!areaIdRaw || Number.isNaN(areaId) || !Number.isFinite(areaId) || areaId <= 0) {
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
	try {
		const db = getDBFromContext(context);
		const area = await queryOne<{ id: number; isHidden: number }>(
			db,
			"SELECT id as id, is_hidden as isHidden FROM discussion_areas WHERE id = ?",
			[Math.floor(areaId)],
		);
		if (!area) {
			return json<ActionData>({ fields, formError: "讨论区不存在" }, { status: 400 });
		}
		if (area.isHidden && user.role !== "superadmin" && user.role !== "topadmin") {
			return json<ActionData>({ fields, formError: "该讨论区已隐藏，无法发帖" }, { status: 403 });
		}
		const permissionReady = await isDiscussionPermissionsReady(context);
		if (permissionReady) {
			const ok = await canPostInDiscussionArea(context, area.id, user.role);
			if (!ok) {
				const ip = getClientIp(request);
				const userAgent = request.headers.get("User-Agent");
				try {
					await execute(
						db,
						"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						[
							user.id,
							"discussion_area_post_denied",
							ip,
							userAgent,
							JSON.stringify({ areaId: area.id, role: user.role, title: trimmedTitle }),
							Date.now(),
						],
					);
				} catch {
				}
				return json<ActionData>({ fields, formError: "当前讨论区禁止发帖" }, { status: 403 });
			}
		}
		const quota = await consumeDailyQuota({ context, request, user, kind: "post" });
		if (!quota.ok) {
			return json<ActionData>({ fields, formError: quota.message }, { status: quota.status });
		}
		const createdAt = Date.now();
		if (wantsHiddenPost) {
			await execute(
				db,
				"INSERT INTO posts (title, content, author_id, created_at, area_id, is_hidden, hidden_at, hidden_by, invited_users) VALUES (?, ?, ?, ?, ?, 1, ?, ?, '[]')",
				[trimmedTitle, trimmedContent, user.id, createdAt, area.id, createdAt, user.id],
			);
		} else {
			await execute(
				db,
				"INSERT INTO posts (title, content, author_id, created_at, area_id) VALUES (?, ?, ?, ?, ?)",
				[trimmedTitle, trimmedContent, user.id, createdAt, area.id],
			);
		}
		const inserted = await queryOne<{ id: number | string }>(db, "SELECT last_insert_rowid() as id", []);
		const postId = Number(inserted?.id ?? 0);
		if (Number.isFinite(postId) && postId > 0 && draftId) {
			try {
				await associateDraftImagesToPost({ context, uploaderId: user.id, draftId, postId: Math.floor(postId) });
			} catch {
			}
		}
		if (lockedAreaIdNum) {
			return redirect(`/areas/${area.id}`);
		}
		return redirect("/posts");
	} catch (error) {
		return json<ActionData>({ fields, formError: "发帖失败，请稍后重试" }, { status: 500 });
	}
}

export default function NewPost() {
	const loaderData = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	const draftId = useMemo(() => crypto.randomUUID(), []);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [contentDraft, setContentDraft] = useState(() => actionData?.fields?.content ?? "");
	const [imageDialogOpen, setImageDialogOpen] = useState(false);
	const [imageUploading, setImageUploading] = useState(false);
	const [imageProgress, setImageProgress] = useState(0);
	const [imageError, setImageError] = useState<string | null>(null);
	const [uploadedPreviews, setUploadedPreviews] = useState<{ imageId: number; url: string; filename: string }[]>([]);
	const uploadedPreviewsRef = useRef<{ imageId: number; url: string; filename: string }[]>([]);

	useEffect(() => {
		uploadedPreviewsRef.current = uploadedPreviews;
	}, [uploadedPreviews]);

	useEffect(() => {
		return () => {
			for (const item of uploadedPreviewsRef.current) {
				try {
					URL.revokeObjectURL(item.url);
				} catch {
				}
			}
		};
	}, []);
	const hasAreas = loaderData.areas.length > 0;
	const fallbackAreaId = hasAreas ? String(loaderData.areas[0].id) : "";
	const selectedAreaId = actionData?.fields?.areaId && actionData.fields.areaId !== "" ? actionData.fields.areaId : fallbackAreaId;
	const lockedArea = loaderData.lockedAreaId ? loaderData.areas.find((a) => a.id === loaderData.lockedAreaId) ?? null : null;
	const canCreateHidden = loaderData.me.role === "topadmin";

	const previewParts = useMemo(() => splitPostContentParts(contentDraft), [contentDraft]);
	const previewMap = useMemo(() => {
		const m = new Map<number, string>();
		for (const item of uploadedPreviews) m.set(item.imageId, item.url);
		return m;
	}, [uploadedPreviews]);

	function insertAtCursor(text: string) {
		const el = textareaRef.current;
		if (!el) {
			setContentDraft((prev) => `${prev}${text}`);
			return;
		}
		const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
		const end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
		const before = contentDraft.slice(0, start);
		const after = contentDraft.slice(end);
		const nextValue = `${before}${text}${after}`;
		setContentDraft(nextValue);
		const nextPos = start + text.length;
		requestAnimationFrame(() => {
			try {
				el.setSelectionRange(nextPos, nextPos);
			} catch {
			}
			el.focus();
		});
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

	async function initiateDraftPostImageUpload(file: File) {
		const { res, data: payload } = await fetchJson(`/api/post-image-drafts/${encodeURIComponent(draftId)}/initiate`, {
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
		const imageId = Number(payload.imageId);
		const url = String(payload.url || `/post-images/${imageId}`);
		return { imageId, url };
	}

	async function uploadMultipart(uploadRecordId: number, file: File, partSizeBytes: number, onProgress: (p: number) => void) {
		const totalParts = Math.ceil(file.size / partSizeBytes);
		const already = await listUploadedParts(uploadRecordId);
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
			const { res, data: payload } = await fetchJson(`/api/post-image-uploads/${uploadRecordId}/parts/${partNumber}`, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body,
			});
			if (!res.ok || !payload?.ok) {
				throw new Error(String(payload?.error || "上传分块失败"));
			}
			completed++;
			onProgress(totalParts > 0 ? completed / totalParts : 0);
		}
		const { res: doneRes, data: done } = await fetchJson(`/api/post-image-uploads/${uploadRecordId}/complete`, { method: "POST" });
		if (!doneRes.ok || !done?.ok) {
			throw new Error(String(done?.error || "完成上传失败"));
		}
		const imageId = Number(done.imageId);
		const url = String(done.url || `/post-images/${imageId}`);
		return { imageId, url };
	}

	async function onPickImage(e: ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0] || null;
		e.target.value = "";
		if (!file) return;
		setImageError(null);
		setImageProgress(0);
		const localErr = validateLocalImage(file);
		if (localErr) {
			setImageError(localErr);
			return;
		}
		setImageUploading(true);
		try {
			const init = await initiateDraftPostImageUpload(file);
			setImageProgress(0.01);
			const partSize = init.partSizeBytes || 1024 * 1024;
			const uploaded =
				init.mode === "single"
					? await (async () => {
						const result = await uploadSingle(init.uploadRecordId, file);
						setImageProgress(1);
						return result;
					})()
					: await uploadMultipart(init.uploadRecordId, file, partSize, (p) => setImageProgress(p));
			setUploadedPreviews((prev) => [{ imageId: uploaded.imageId, url: uploaded.url, filename: file.name }, ...prev]);
			insertAtCursor(`[[img:${uploaded.imageId}]]`);
			setImageDialogOpen(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : "插图上传失败";
			setImageError(message || "插图上传失败");
		} finally {
			setImageUploading(false);
		}
	}

	function openImageDialog() {
		if (isSubmitting || !hasAreas) return;
		setImageError(null);
		setImageProgress(0);
		setImageDialogOpen(true);
	}

	function closeImageDialog() {
		if (imageUploading) return;
		setImageDialogOpen(false);
		setImageError(null);
		setImageProgress(0);
	}

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeImageDialog();
		};
		if (imageDialogOpen) window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [imageDialogOpen, imageUploading]);

	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="w-full max-w-2xl rounded-xl bg-white p-8 shadow dark:bg-gray-800">
				<h1 className="mb-6 text-center text-2xl font-semibold text-gray-900 dark:text-gray-100">
					发布新帖子
				</h1>
				<Form method="post" className="space-y-5">
					<input type="hidden" name="draftId" value={draftId} />
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
							讨论区
						</label>
						{lockedArea ? (
							<div className="space-y-2">
								<input type="hidden" name="areaId" value={lockedArea.id} />
								<input
									value={lockedArea.name}
									disabled
									className="w-full rounded border border-gray-300 bg-gray-100 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900/40 dark:text-gray-100"
								/>
								<p className="text-xs text-gray-500 dark:text-gray-400">已锁定为当前讨论区，不能切换。</p>
							</div>
						) : (
							<select
								name="areaId"
								required
								defaultValue={selectedAreaId}
								className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
							>
								<option value="" disabled>
									请选择讨论区
								</option>
								{loaderData.areas.map((a) => (
									<option key={a.id} value={a.id}>
										{a.name}{a.isHidden ? "（隐藏）" : ""}
									</option>
								))}
							</select>
						)}
						{!hasAreas ? (
							<p className="mt-1 text-xs text-red-600">暂无可发帖的讨论区，请联系管理员。</p>
						) : null}
						{actionData?.fieldErrors?.areaId ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.areaId}</p>
						) : null}
					</div>
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
							标题
						</label>
						<input
							name="title"
							required
							defaultValue={actionData?.fields?.title ?? ""}
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.title ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.title}</p>
						) : null}
					</div>
					<div>
						<div className="mb-1 flex items-center justify-between gap-3">
							<label className="block text-sm font-medium text-gray-700 dark:text-gray-200">内容</label>
							<button
								type="button"
								onClick={openImageDialog}
								disabled={isSubmitting || !hasAreas}
								className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-70 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
							>
								🖼️ 插入图片
							</button>
						</div>
						<textarea
							ref={textareaRef}
							name="content"
							rows={8}
							required
							value={contentDraft}
							onChange={(e) => setContentDraft(e.target.value)}
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.content ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.content}</p>
						) : null}
						<div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/30">
							<div className="text-xs font-medium text-gray-700 dark:text-gray-200">预览</div>
							<div className="mt-2 space-y-2 whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">
								{previewParts.map((p, idx) =>
									p.type === "text" ? (
										<span key={`t_${idx}`}>{p.text}</span>
									) : previewMap.get(p.imageId) ? (
										<img
											key={`i_${p.imageId}_${idx}`}
											src={previewMap.get(p.imageId)}
											alt={`图片 ${p.imageId}`}
											className="max-w-full rounded border border-gray-200 dark:border-gray-700"
										/>
									) : (
										<span key={`i_${p.imageId}_${idx}`} className="text-xs text-gray-500 dark:text-gray-400">
											图片 #{p.imageId}（发布后可见）
										</span>
									),
								)}
							</div>
						</div>
					</div>
					{canCreateHidden ? (
						<div className="flex items-center gap-2">
							<input id="isHiddenPost" name="isHiddenPost" type="checkbox" value="1" className="h-4 w-4" />
							<label htmlFor="isHiddenPost" className="text-sm text-gray-700 dark:text-gray-200">
								创建为隐藏帖子（仅受邀用户可通过链接访问）
							</label>
						</div>
					) : null}
					{actionData?.formError ? (
						<p className="text-sm text-red-600">{actionData.formError}</p>
					) : null}
					<div className="flex items-center justify-between">
						<a
							href="/posts"
							className="text-sm text-gray-600 hover:underline dark:text-gray-300"
						>
							返回列表
						</a>
						<button
							type="submit"
							disabled={isSubmitting || !hasAreas}
							className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
						>
							{isSubmitting ? "发布中..." : "发布"}
						</button>
					</div>
				</Form>
				{imageDialogOpen ? (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
						<div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-lg dark:bg-gray-900">
							<div className="flex items-start justify-between gap-4">
								<div>
									<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">插入图片</h2>
									<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">支持 JPG、PNG、GIF、WebP；单张不超过 5MB</p>
								</div>
								<button
									type="button"
									onClick={closeImageDialog}
									disabled={imageUploading}
									className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-70 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
								>
									关闭
								</button>
							</div>
							<div className="mt-4 space-y-3">
								<input
									ref={fileInputRef}
									type="file"
									accept="image/jpeg,image/png,image/gif,image/webp"
									onChange={onPickImage}
									disabled={imageUploading}
									className="block w-full text-sm text-gray-700 file:mr-4 file:rounded file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-blue-700 dark:text-gray-200 dark:file:bg-blue-600 dark:hover:file:bg-blue-700"
								/>
								{imageUploading ? (
									<div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-200">
										<div className="flex items-center justify-between">
											<span>上传进度</span>
											<span>{Math.max(0, Math.min(100, Math.round(imageProgress * 100)))}%</span>
										</div>
										<div className="mt-2 h-2 w-full overflow-hidden rounded bg-blue-100 dark:bg-blue-900/40">
											<div className="h-2 bg-blue-600" style={{ width: `${Math.max(0, Math.min(100, Math.round(imageProgress * 100)))}%` }} />
										</div>
									</div>
								) : null}
								{imageError ? <div className="text-sm text-red-600">{imageError}</div> : null}
							</div>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
