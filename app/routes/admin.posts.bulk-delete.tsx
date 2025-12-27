import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { assertNotBanned, getClientIp, isSuperadmin, requireUser, verifyLogin } from "~/lib/auth.server";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";
import { removeAllAttachmentsForPost, removeAllCommentAttachmentsForPost } from "~/lib/attachments.server";
import { removeAllPostImagesForPost } from "~/lib/post-images.server";

type BannedPostRow = {
	id: number;
	title: string;
	authorId: number;
	authorName: string | null;
	createdAt: number;
	bannedAt: number | null;
	bannedBy: number | null;
	bannedByName: string | null;
	bannedReason: string | null;
	commentCount: number;
	attachmentCount: number;
	commentAttachmentCount: number;
	imageCount: number;
};

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	posts: BannedPostRow[];
	page: number;
	pageSize: number;
	totalCount: number;
	totalPages: number;
};

type ActionData =
	| { ok: true; deletedCount: number; deletedPostIds: number[] }
	| { ok: false; error: string };

function parsePositiveInt(value: string | null, fallback: number) {
	if (!value) return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}

function getSelectedIds(formData: FormData) {
	const ids = formData
		.getAll("id")
		.map((v) => Number(v))
		.filter((n) => Number.isFinite(n) && n > 0)
		.map((n) => Math.floor(n));
	return Array.from(new Set(ids));
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (!isSuperadmin(me)) {
		throw new Response("只有超级管理员或站点管理员可访问", { status: 403 });
	}

	const url = new URL(request.url);
	const pageSize = 20;
	const requestedPage = parsePositiveInt(url.searchParams.get("page"), 1);
	const db = getDBFromContext(context);

	const countRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM posts WHERE is_banned = 1 AND deleted_at IS NULL",
	);
	const totalCount = Number(countRow?.count ?? 0);
	const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
	const page = Math.min(requestedPage, totalPages);
	const offset = (page - 1) * pageSize;

	const posts = await queryAll<BannedPostRow>(
		db,
		"SELECT p.id as id, p.title as title, p.author_id as authorId, au.display_name as authorName, p.created_at as createdAt, p.banned_at as bannedAt, p.banned_by as bannedBy, bu.display_name as bannedByName, p.banned_reason as bannedReason, (SELECT COUNT(1) FROM comments c WHERE c.post_id = p.id) as commentCount, (SELECT COUNT(1) FROM attachments a WHERE a.post_id = p.id) as attachmentCount, (SELECT COUNT(1) FROM comment_attachments ca WHERE ca.post_id = p.id) as commentAttachmentCount, (SELECT COUNT(1) FROM post_images i WHERE i.post_id = p.id) as imageCount FROM posts p LEFT JOIN users au ON au.id = p.author_id LEFT JOIN users bu ON bu.id = p.banned_by WHERE p.is_banned = 1 AND p.deleted_at IS NULL ORDER BY p.banned_at DESC, p.id DESC LIMIT ? OFFSET ?",
		[pageSize, offset],
	);

	return json<LoaderData>({ me, posts, page, pageSize, totalCount, totalPages });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (!isSuperadmin(me)) {
		return json<ActionData>({ ok: false, error: "只有超级管理员或站点管理员可以批量删除封禁帖子" }, { status: 403 });
	}

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "").trim();
	if (intent !== "hardDeleteBannedPosts") {
		return json<ActionData>({ ok: false, error: "未知操作" }, { status: 400 });
	}
	const ids = getSelectedIds(formData);
	if (ids.length === 0) {
		return json<ActionData>({ ok: false, error: "未选择要删除的帖子" }, { status: 400 });
	}
	if (ids.length > 200) {
		return json<ActionData>({ ok: false, error: "一次最多删除 200 条" }, { status: 400 });
	}

	const confirm = String(formData.get("confirm") || "").trim();
	if (confirm !== "1") {
		return json<ActionData>({ ok: false, error: "需要二次确认" }, { status: 400 });
	}
	const password = String(formData.get("password") || "");
	if (!password) {
		return json<ActionData>({ ok: false, error: "需要二次验证密码" }, { status: 400 });
	}
	const verified = await verifyLogin(context, me.email, password);
	if (!verified || verified.id !== me.id) {
		return json<ActionData>({ ok: false, error: "二次验证失败" }, { status: 403 });
	}

	const db = getDBFromContext(context);
	const placeholders = ids.map(() => "?").join(",");
	const rows = await queryAll<{ id: number }>(
		db,
		`SELECT id as id FROM posts WHERE deleted_at IS NULL AND is_banned = 1 AND id IN (${placeholders})`,
		ids,
	);
	const deletableIds = rows.map((r) => r.id);
	if (deletableIds.length === 0) {
		return json<ActionData>({ ok: false, error: "无可删除的封禁帖子" }, { status: 400 });
	}

	const ip = getClientIp(request);
	const userAgent = request.headers.get("User-Agent");
	const startedAt = Date.now();

	try {
		for (const postId of deletableIds) {
			await removeAllAttachmentsForPost(context, postId);
			await removeAllCommentAttachmentsForPost(context, postId);
			await removeAllPostImagesForPost(context, postId);
		}

		const delPlaceholders = deletableIds.map(() => "?").join(",");
		await execute(db, `DELETE FROM post_likes WHERE post_id IN (${delPlaceholders})`, deletableIds);
		await execute(db, `DELETE FROM comments WHERE post_id IN (${delPlaceholders})`, deletableIds);
		await execute(db, `DELETE FROM posts WHERE id IN (${delPlaceholders})`, deletableIds);

		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					me.id,
					"posts_banned_bulk_deleted",
					ip,
					userAgent,
					JSON.stringify({ count: deletableIds.length, postIds: deletableIds, requestedIds: ids }),
					startedAt,
				],
			);
		} catch {
		}

		return json<ActionData>({ ok: true, deletedCount: deletableIds.length, deletedPostIds: deletableIds });
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					me.id,
					"posts_banned_bulk_delete_failed",
					ip,
					userAgent,
					JSON.stringify({ requestedIds: ids, message }),
					Date.now(),
				],
			);
		} catch {
		}
		return json<ActionData>({ ok: false, error: "删除失败，请稍后重试" }, { status: 500 });
	}
}

export default function AdminBulkDeleteBannedPostsPage() {
	const data = useLoaderData<typeof loader>();
	const revalidator = useRevalidator();
	const deleteFetcher = useFetcher<ActionData>();
	const handledRef = useRef(false);
	const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
	const [confirmChecked, setConfirmChecked] = useState(false);
	const [password, setPassword] = useState("");

	useEffect(() => {
		setSelectedIds(new Set());
		setConfirmChecked(false);
		setPassword("");
	}, [data.page]);

	useEffect(() => {
		if (deleteFetcher.state === "submitting") {
			handledRef.current = false;
			return;
		}
		if (deleteFetcher.state !== "idle") return;
		if (!deleteFetcher.data) return;
		if (handledRef.current) return;
		if (!deleteFetcher.data.ok) return;
		handledRef.current = true;
		setSelectedIds(new Set());
		setConfirmChecked(false);
		setPassword("");
		revalidator.revalidate();
	}, [deleteFetcher.state, deleteFetcher.data, revalidator]);

	const allOnPageSelected = data.posts.length > 0 && data.posts.every((p) => selectedIds.has(p.id));
	const selectedCount = selectedIds.size;
	const canSubmit =
		selectedCount > 0 &&
		selectedCount <= 200 &&
		confirmChecked &&
		Boolean(password) &&
		deleteFetcher.state !== "submitting";
	const error = deleteFetcher.data && !deleteFetcher.data.ok ? deleteFetcher.data.error : null;

	function toggleSelect(id: number) {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function toggleSelectAllOnPage() {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (allOnPageSelected) {
				for (const p of data.posts) next.delete(p.id);
			} else {
				for (const p of data.posts) next.add(p.id);
			}
			return next;
		});
	}

	function submitBulkDelete() {
		const ids = Array.from(selectedIds);
		if (ids.length === 0) return;
		if (ids.length > 200) return;
		if (!confirmChecked) return;
		if (!password) return;
		const ok = window.confirm(`确认永久删除所选 ${ids.length} 条封禁帖子吗？此操作不可恢复。`);
		if (!ok) return;
		const form = new FormData();
		form.append("intent", "hardDeleteBannedPosts");
		form.append("confirm", "1");
		form.append("password", password);
		for (const id of ids) form.append("id", String(id));
		deleteFetcher.submit(form, { method: "post" });
	}

	const queryString = useMemo(() => {
		const sp = new URLSearchParams();
		if (data.page > 1) sp.set("page", String(data.page));
		const s = sp.toString();
		return s ? `?${s}` : "";
	}, [data.page]);
	const canPrev = data.page > 1;
	const canNext = data.page < data.totalPages;

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-5xl flex-col gap-6">
				<header className="flex items-center justify-between gap-3">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">批量删除封禁帖子</h1>
					<div className="flex flex-wrap items-center gap-2">
						<Link
							to="/admin/users"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							用户管理
						</Link>
						<Link
							to="/posts"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							返回论坛
						</Link>
					</div>
				</header>

				{error ? (
					<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						{error}
					</div>
				) : null}

				<div className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
						<div className="text-sm text-gray-700 dark:text-gray-200">
							<div>当前封禁帖子：{data.totalCount} 条</div>
							<div>已选：{selectedCount} 条（单次最多 200 条）</div>
						</div>
						<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
							<label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
								<input
									type="checkbox"
									checked={confirmChecked}
									onChange={(e) => setConfirmChecked(e.target.checked)}
								/>
								<span>我已了解此操作不可恢复</span>
							</label>
							<label className="flex flex-col gap-1 text-sm text-gray-700 dark:text-gray-200">
								<span>二次验证密码</span>
								<input
									type="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									className="w-56 rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
									placeholder="请输入当前账号密码"
								/>
							</label>
							<button
								type="button"
								onClick={submitBulkDelete}
								disabled={!canSubmit}
								className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
							>
								{deleteFetcher.state === "submitting" ? "删除中..." : "批量永久删除"}
							</button>
						</div>
					</div>
				</div>

				<div className="overflow-hidden rounded-xl bg-white shadow dark:bg-gray-800">
					<table className="w-full table-auto text-left text-sm">
						<thead className="bg-gray-100 text-xs text-gray-600 dark:bg-gray-900/30 dark:text-gray-300">
							<tr>
								<th className="px-4 py-3">
									<label className="flex items-center gap-2">
										<input type="checkbox" checked={allOnPageSelected} onChange={toggleSelectAllOnPage} />
										<span>全选本页</span>
									</label>
								</th>
								<th className="px-4 py-3">ID</th>
								<th className="px-4 py-3">标题</th>
								<th className="px-4 py-3">作者</th>
								<th className="px-4 py-3">封禁信息</th>
								<th className="px-4 py-3">关联数据</th>
								<th className="px-4 py-3">创建时间</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-200 dark:divide-gray-700">
							{data.posts.map((p) => (
								<tr key={p.id} className="text-gray-900 dark:text-gray-100">
									<td className="px-4 py-3">
										<input
											type="checkbox"
											checked={selectedIds.has(p.id)}
											onChange={() => toggleSelect(p.id)}
										/>
									</td>
									<td className="px-4 py-3">{p.id}</td>
									<td className="px-4 py-3">
										<Link to={`/posts/${p.id}`} className="text-blue-600 hover:underline dark:text-blue-400">
											{p.title}
										</Link>
									</td>
									<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
										{p.authorName || "-"}（{p.authorId}）
									</td>
									<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
										<div>{p.bannedAt ? new Date(p.bannedAt).toLocaleString() : "-"}</div>
										<div className="text-xs text-gray-500 dark:text-gray-400">
											操作者：{p.bannedByName || "-"}
											{p.bannedBy ? `（${p.bannedBy}）` : ""}
										</div>
										{p.bannedReason ? (
											<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">原因：{p.bannedReason}</div>
										) : null}
									</td>
									<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
										<div>评论：{p.commentCount}</div>
										<div className="text-xs text-gray-500 dark:text-gray-400">
											附件：{p.attachmentCount}；评论附件：{p.commentAttachmentCount}；图片：{p.imageCount}
										</div>
									</td>
									<td className="px-4 py-3 text-gray-700 dark:text-gray-200">{new Date(p.createdAt).toLocaleString()}</td>
								</tr>
							))}
							{data.posts.length === 0 ? (
								<tr>
									<td className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400" colSpan={7}>
										暂无封禁帖子
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>

				<div className="flex items-center justify-between">
					<div className="text-sm text-gray-600 dark:text-gray-300">
						第 {data.page} / {data.totalPages} 页
					</div>
					<div className="flex items-center gap-2">
						<Link
							to={`/admin/posts/bulk-delete${canPrev ? `?page=${data.page - 1}` : queryString}`}
							aria-disabled={!canPrev}
							className={
								canPrev
									? "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									: "cursor-not-allowed rounded border border-gray-200 px-3 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-600"
							}
							onClick={(e) => {
								if (!canPrev) e.preventDefault();
							}}
						>
							上一页
						</Link>
						<Link
							to={`/admin/posts/bulk-delete?page=${data.page + 1}`}
							aria-disabled={!canNext}
							className={
								canNext
									? "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									: "cursor-not-allowed rounded border border-gray-200 px-3 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-600"
							}
							onClick={(e) => {
								if (!canNext) e.preventDefault();
							}}
						>
							下一页
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}

