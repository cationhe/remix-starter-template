import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Form, Link, useLoaderData } from "@remix-run/react";
import { findUserById } from "~/lib/auth.server";
import { getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";
import { getSession } from "~/lib/session.server";

type AreaRow = {
	id: number;
	name: string;
	isHidden: number;
};

type PostListItem = {
	id: number;
	title: string;
	createdAt: number;
	authorName: string;
	isBanned: number;
	pinnedUntilMs: number | null;
	preview: string;
};

type LoaderData = {
	user: Awaited<ReturnType<typeof findUserById>>;
	area: AreaRow;
	posts: PostListItem[];
	q: string;
	page: number;
	pageSize: number;
	totalCount: number;
	totalPages: number;
};

function clampPage(value: string | null, totalPages: number) {
	const raw = String(value ?? "").trim();
	const n = Number(raw);
	const page = Number.isFinite(n) ? Math.floor(n) : 1;
	const safe = page <= 0 ? 1 : page;
	if (totalPages <= 0) return 1;
	return safe > totalPages ? totalPages : safe;
}

function normalizeQuery(value: string | null) {
	const q = String(value ?? "").trim();
	if (!q) return "";
	return q.length > 50 ? q.slice(0, 50) : q;
}

function buildQueryString(args: { q: string; page: number }) {
	const sp = new URLSearchParams();
	if (args.q) sp.set("q", args.q);
	if (args.page > 1) sp.set("page", String(args.page));
	const s = sp.toString();
	return s ? `?${s}` : "";
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
	const idRaw = String(params.id ?? "").trim();
	const idNum = Number(idRaw);
	const areaId = Number.isFinite(idNum) ? Math.floor(idNum) : NaN;
	if (!areaId || Number.isNaN(areaId) || areaId <= 0) {
		throw new Response("无效的讨论区", { status: 404 });
	}

	const session = await getSession(request, context);
	const userId = session.get("userId") as number | undefined;
	let user: Awaited<ReturnType<typeof findUserById>> = null;
	if (userId) {
		user = await findUserById(context, userId);
	}
	const canSeeHidden = user?.role === "superadmin";

	const db = getDBFromContext(context);
	const area = await queryOne<AreaRow>(
		db,
		"SELECT id as id, name as name, is_hidden as isHidden FROM discussion_areas WHERE id = ?",
		[areaId],
	);
	if (!area) {
		throw new Response("讨论区不存在", { status: 404 });
	}
	if (area.isHidden && !canSeeHidden) {
		throw new Response("讨论区不存在", { status: 404 });
	}

	const url = new URL(request.url);
	const q = normalizeQuery(url.searchParams.get("q"));
	const pageSize = 20;
	const where: string[] = ["p.area_id = ?"];
	const whereArgs: Array<string | number> = [areaId];
	if (q) {
		where.push("(p.title LIKE ? OR p.content LIKE ?)");
		const pattern = `%${q}%`;
		whereArgs.push(pattern, pattern);
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

	const countRow = await queryOne<{ count: number | string }>(
		db,
		`SELECT COUNT(1) as count FROM posts p ${whereSql}`,
		whereArgs,
	);
	const totalCount = Number(countRow?.count ?? 0);
	const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
	const page = clampPage(url.searchParams.get("page"), totalPages);
	const offset = (page - 1) * pageSize;
	const now = Date.now();

	type PostDbRow = {
		id: number;
		title: string;
		content: string;
		createdAt: number;
		authorName: string;
		isBanned: number;
		pinnedUntilMs: number | null;
		pinnedAt: number | null;
	};
	const rows = await queryAll<PostDbRow>(
		db,
		`SELECT p.id as id,
		        p.title as title,
		        p.content as content,
		        p.created_at as createdAt,
		        u.display_name as authorName,
		        p.is_banned as isBanned,
		        p.pinned_until_ms as pinnedUntilMs,
		        p.pinned_at as pinnedAt
		 FROM posts p
		 JOIN users u ON p.author_id = u.id
		 ${whereSql}
		 ORDER BY (CASE WHEN p.pinned_until_ms = 0 OR p.pinned_until_ms > ? THEN 1 ELSE 0 END) DESC,
		          p.pinned_at DESC,
		          p.created_at DESC
		 LIMIT ? OFFSET ?`,
		[...whereArgs, now, pageSize, offset],
	);
	const posts: PostListItem[] = rows.map((r: PostDbRow) => {
		const text = String(r.content ?? "")
			.replace(/\s+/g, " ")
			.replace(/\u0000/g, "")
			.trim();
		return {
			id: r.id,
			title: r.title,
			createdAt: r.createdAt,
			authorName: r.authorName,
			isBanned: r.isBanned,
			pinnedUntilMs: r.pinnedUntilMs,
			preview: text.length > 140 ? `${text.slice(0, 140)}…` : text,
		};
	});

	return json<LoaderData>({
		user,
		area,
		posts,
		q,
		page,
		pageSize,
		totalCount,
		totalPages,
	});
}

export default function AreaPostsPage() {
	const data = useLoaderData<typeof loader>();
	const now = Date.now();
	const hasPrev = data.page > 1;
	const hasNext = data.page < data.totalPages;
	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex flex-col gap-2">
					<div className="flex items-start justify-between gap-4">
						<div>
							<div className="flex items-center gap-2">
								<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{data.area.name}</h1>
								{data.area.isHidden ? (
									<span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-100">
										隐藏
									</span>
								) : null}
							</div>
							<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">共 {data.totalCount} 帖，按时间倒序</div>
						</div>
						<Link to="/posts" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
							返回讨论区列表
						</Link>
					</div>
					<Form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-center">
						<input
							name="q"
							defaultValue={data.q}
							placeholder="搜索标题或内容"
							className="w-full flex-1 rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
						/>
						<button type="submit" className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
							搜索
						</button>
						{data.q ? (
							<Link to={`/areas/${data.area.id}`} className="text-sm text-gray-600 hover:underline dark:text-gray-300">
								清除
							</Link>
						) : null}
					</Form>
				</header>

				{data.posts.length === 0 ? (
					<div className="rounded-xl bg-white p-6 text-sm text-gray-600 shadow dark:bg-gray-800 dark:text-gray-300">
						{data.q ? "没有匹配的帖子" : "暂无帖子"}
					</div>
				) : (
					<ul className="divide-y divide-gray-200 overflow-hidden rounded-xl bg-white shadow dark:divide-gray-700 dark:bg-gray-800">
						{data.posts.map((post) => {
							const pinned =
								post.pinnedUntilMs === 0 ||
								(typeof post.pinnedUntilMs === "number" && post.pinnedUntilMs > now);
							const banned = Boolean(post.isBanned);
							return (
								<li key={post.id} className={pinned ? "bg-amber-50/60 px-6 py-4 dark:bg-amber-900/10" : "px-6 py-4"}>
									<Link
										to={`/posts/${post.id}`}
										className="block truncate text-base font-medium text-blue-700 hover:underline dark:text-blue-400"
									>
										{post.title}
									</Link>
									<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
										<span>作者：{post.authorName}</span>
										<span>发布时间：{new Date(post.createdAt).toLocaleString()}</span>
										{pinned ? (
											<span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">置顶</span>
										) : null}
										{banned ? (
											<span className="rounded bg-red-100 px-2 py-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-200">已封禁</span>
										) : null}
									</div>
									{post.preview ? (
										<p className="mt-2 line-clamp-2 text-sm text-gray-700 dark:text-gray-200">{post.preview}</p>
									) : null}
								</li>
							);
						})}
					</ul>
				)}

				<div className="flex items-center justify-between gap-3">
					<div className="text-xs text-gray-500 dark:text-gray-400">
						第 {data.page} / {data.totalPages} 页
					</div>
					<div className="flex items-center gap-2">
						{hasPrev ? (
							<Link
								to={`/areas/${data.area.id}${buildQueryString({ q: data.q, page: data.page - 1 })}`}
								className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
							>
								上一页
							</Link>
						) : (
							<span className="rounded border border-gray-200 px-3 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-500">上一页</span>
						)}
						{hasNext ? (
							<Link
								to={`/areas/${data.area.id}${buildQueryString({ q: data.q, page: data.page + 1 })}`}
								className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
							>
								下一页
							</Link>
						) : (
							<span className="rounded border border-gray-200 px-3 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-500">下一页</span>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

