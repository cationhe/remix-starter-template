import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getClientIp, requireUser } from "~/lib/auth.server";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";

type PostRow = {
	id: number;
	title: string;
	createdAt: number;
	deletedAt: number | null;
	commentCount: number;
};

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	posts: PostRow[];
	page: number;
	pageSize: number;
	totalCount: number;
	totalPages: number;
	showDeleted: boolean;
};

type ActionData = { ok: true; deletedCount: number } | { ok: false; error: string };

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
	const unique = Array.from(new Set(ids));
	return unique;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	const url = new URL(request.url);
	const pageSize = 20;
	const requestedPage = parsePositiveInt(url.searchParams.get("page"), 1);
	const showDeleted = url.searchParams.get("showDeleted") === "1";
	const db = getDBFromContext(context);
	const where = showDeleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
	const countRow = await queryOne<{ count: number | string }>(
		db,
		`SELECT COUNT(1) as count FROM posts WHERE author_id = ? AND ${where}`,
		[me.id],
	);
	const totalCount = Number(countRow?.count ?? 0);
	const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
	const page = Math.min(requestedPage, totalPages);
	const offset = (page - 1) * pageSize;
	const posts = await queryAll<PostRow>(
		db,
		`SELECT p.id as id,
		        p.title as title,
		        p.created_at as createdAt,
		        p.deleted_at as deletedAt,
		        (SELECT COUNT(1) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) as commentCount
		 FROM posts p
		 WHERE p.author_id = ?
		   AND p.${where}
		 ORDER BY p.created_at DESC
		 LIMIT ? OFFSET ?`,
		[me.id, pageSize, offset],
	);
	return json<LoaderData>({ me, posts, page, pageSize, totalCount, totalPages, showDeleted });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	const formData = await request.formData();
	const intent = String(formData.get("intent") || "").trim();
	if (intent !== "softDelete") {
		return json<ActionData>({ ok: false, error: "未知操作" }, { status: 400 });
	}
	const ids = getSelectedIds(formData);
	if (ids.length === 0) {
		return json<ActionData>({ ok: false, error: "未选择要删除的帖子" }, { status: 400 });
	}
	if (ids.length > 500) {
		return json<ActionData>({ ok: false, error: "一次最多删除 500 条" }, { status: 400 });
	}
	const db = getDBFromContext(context);
	const placeholders = ids.map(() => "?").join(",");
	const owned = await queryAll<{ id: number }>(
		db,
		`SELECT id as id FROM posts WHERE author_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
		[me.id, ...ids],
	);
	const ownedIds = owned.map((r) => r.id);
	if (ownedIds.length === 0) {
		return json<ActionData>({ ok: false, error: "无可删除的帖子" }, { status: 400 });
	}
	const ownedPlaceholders = ownedIds.map(() => "?").join(",");
	const now = Date.now();
	await execute(
		db,
		`UPDATE posts SET deleted_at = ?, deleted_by = ? WHERE author_id = ? AND deleted_at IS NULL AND id IN (${ownedPlaceholders})`,
		[now, me.id, me.id, ...ownedIds],
	);
	const ip = getClientIp(request);
	const userAgent = request.headers.get("User-Agent");
	try {
		await execute(
			db,
			"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			[me.id, "me_posts_soft_deleted", ip, userAgent, JSON.stringify({ count: ownedIds.length, postIds: ownedIds }), now],
		);
	} catch {
	}
	return json<ActionData>({ ok: true, deletedCount: ownedIds.length });
}

export default function MePostsPage() {
	const data = useLoaderData<typeof loader>();
	const revalidator = useRevalidator();
	const deleteFetcher = useFetcher<ActionData>();
	const handledRef = useRef(false);
	const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());

	useEffect(() => {
		setSelectedIds(new Set());
	}, [data.page, data.showDeleted]);

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
		revalidator.revalidate();
	}, [deleteFetcher.state, deleteFetcher.data, revalidator]);

	const allOnPageSelected =
		!data.showDeleted && data.posts.length > 0 && data.posts.every((p) => selectedIds.has(p.id));
	const selectedCount = selectedIds.size;
	const canBulkDelete =
		!data.showDeleted && selectedCount > 0 && selectedCount <= 500 && deleteFetcher.state !== "submitting";
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
		if (ids.length > 500) return;
		const form = new FormData();
		form.append("intent", "softDelete");
		for (const id of ids) form.append("id", String(id));
		deleteFetcher.submit(form, { method: "post" });
	}

	const queryString = useMemo(() => {
		const sp = new URLSearchParams();
		if (data.showDeleted) sp.set("showDeleted", "1");
		if (data.page > 1) sp.set("page", String(data.page));
		const s = sp.toString();
		return s ? `?${s}` : "";
	}, [data.showDeleted, data.page]);
	const basePath = "/me/posts";
	const canPrev = data.page > 1;
	const canNext = data.page < data.totalPages;

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<header className="flex items-start justify-between gap-4">
					<div>
						<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">我的帖子管理</h1>
						<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
							{data.me.displayName}（{data.me.role}）
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Link
							to="/me"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							返回个人中心
						</Link>
						<Link
							to={data.showDeleted ? "/me/posts" : "/me/posts?showDeleted=1"}
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							{data.showDeleted ? "查看未删除" : "查看已删除"}
						</Link>
						<Link
							to="/me/comments"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							我的评论管理
						</Link>
					</div>
				</header>

				{error ? (
					<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						{error}
					</div>
				) : null}

				<section className="overflow-hidden rounded-xl bg-white shadow dark:bg-gray-800">
					<div className="flex flex-col gap-3 border-b border-gray-200 p-4 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between">
						<div className="text-sm text-gray-700 dark:text-gray-200">
							共 {data.totalCount} 条， 第 {data.page} / {data.totalPages} 页
						</div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={submitBulkDelete}
								disabled={!canBulkDelete}
								className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
							>
								删除所选{selectedCount > 0 ? `（${selectedCount}）` : ""}
							</button>
						</div>
					</div>
					<table className="w-full table-auto text-left text-sm">
						<thead className="bg-gray-100 text-xs text-gray-600 dark:bg-gray-900/30 dark:text-gray-300">
							<tr>
								<th className="px-4 py-3">
									{data.showDeleted ? null : (
										<input type="checkbox" checked={allOnPageSelected} onChange={toggleSelectAllOnPage} />
									)}
								</th>
								<th className="px-4 py-3">标题</th>
								<th className="px-4 py-3">评论</th>
								<th className="px-4 py-3">创建时间</th>
								{data.showDeleted ? <th className="px-4 py-3">删除时间</th> : null}
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-200 dark:divide-gray-700">
							{data.posts.map((p) => (
								<tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/20">
									<td className="px-4 py-3">
										{data.showDeleted ? null : (
											<input
												type="checkbox"
												checked={selectedIds.has(p.id)}
												onChange={() => toggleSelect(p.id)}
											/>
										)}
									</td>
									<td className="px-4 py-3">
										{data.showDeleted ? (
											<span className="text-gray-900 dark:text-gray-100">{p.title}</span>
										) : (
											<Link
												to={`/posts/${p.id}`}
												className="text-blue-600 hover:underline dark:text-blue-400"
											>
												{p.title}
											</Link>
										)}
										<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">ID: {p.id}</div>
									</td>
									<td className="px-4 py-3 text-gray-700 dark:text-gray-200">{p.commentCount}</td>
									<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
										{new Date(p.createdAt).toLocaleString()}
									</td>
									{data.showDeleted ? (
										<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
											{p.deletedAt ? new Date(p.deletedAt).toLocaleString() : ""}
										</td>
									) : null}
								</tr>
							))}
							{data.posts.length === 0 ? (
								<tr>
									<td
										colSpan={data.showDeleted ? 5 : 4}
										className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400"
									>
										暂无数据
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
					<div className="flex items-center justify-between border-t border-gray-200 p-4 text-sm dark:border-gray-700">
						<Link
							to={`${basePath}${(() => {
								const sp = new URLSearchParams();
								if (data.showDeleted) sp.set("showDeleted", "1");
								if (data.page - 1 > 1) sp.set("page", String(data.page - 1));
								const s = sp.toString();
								return s ? `?${s}` : "";
							})()}`}
							className={
								canPrev
									? "rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									: "pointer-events-none rounded border border-gray-200 px-3 py-1 text-gray-400 dark:border-gray-800 dark:text-gray-500"
							}
						>
							上一页
						</Link>
						<span className="text-gray-600 dark:text-gray-300">{queryString}</span>
						<Link
							to={`${basePath}${(() => {
								const sp = new URLSearchParams();
								if (data.showDeleted) sp.set("showDeleted", "1");
								sp.set("page", String(data.page + 1));
								const s = sp.toString();
								return s ? `?${s}` : "";
							})()}`}
							className={
								canNext
									? "rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									: "pointer-events-none rounded border border-gray-200 px-3 py-1 text-gray-400 dark:border-gray-800 dark:text-gray-500"
							}
						>
							下一页
						</Link>
					</div>
				</section>
			</div>
		</div>
	);
}

