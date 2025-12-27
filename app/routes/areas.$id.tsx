import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Form, Link, isRouteErrorResponse, useLoaderData, useLocation, useNavigation, useRouteError } from "@remix-run/react";
import { findUserById, getClientIp } from "~/lib/auth.server";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";
import { getSession } from "~/lib/session.server";
import { canPostInDiscussionArea, canViewDiscussionArea, isDiscussionPermissionsReady } from "~/lib/discussion-permissions.server";

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
	canPost: boolean;
	q: string;
	page: number;
	pageSize: number;
	totalCount: number;
	totalPages: number;
};

const FIXED_PAGE_SIZE = 20;

function parsePositiveInt(value: string | null) {
	const raw = String(value ?? "").trim();
	if (!raw) return null;
	const n = Number(raw);
	if (!Number.isFinite(n)) return null;
	const int = Math.floor(n);
	if (String(int) !== raw && String(n) !== raw) return null;
	if (int <= 0) return null;
	return int;
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
	const canSeeHidden = user?.role === "superadmin" || user?.role === "topadmin";

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
	if (user) {
		const permissionReady = await isDiscussionPermissionsReady(context);
		if (permissionReady) {
			const ok = await canViewDiscussionArea(context, areaId, user.role);
			if (!ok) {
				const ip = getClientIp(request);
				const userAgent = request.headers.get("User-Agent");
				try {
					await execute(
						getDBFromContext(context),
						"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						[
							user.id,
							"discussion_area_view_denied",
							ip,
							userAgent,
							JSON.stringify({ areaId, role: user.role, path: new URL(request.url).pathname }),
							Date.now(),
						],
					);
				} catch {
				}
				throw new Response("讨论区不存在", { status: 404 });
			}
		}
	}

	let canPost = Boolean(user) && !Boolean(user?.isBanned);
	if (user) {
		const permissionReady = await isDiscussionPermissionsReady(context);
		if (permissionReady) {
			canPost = canPost && (await canPostInDiscussionArea(context, areaId, user.role));
		}
	}

	const url = new URL(request.url);
	const q = normalizeQuery(url.searchParams.get("q"));
	const pageSizeRaw = url.searchParams.get("pageSize");
	const requestedPageSize = pageSizeRaw ? parsePositiveInt(pageSizeRaw) : FIXED_PAGE_SIZE;
	if (!requestedPageSize) {
		throw new Response("pageSize 参数无效", { status: 400 });
	}
	if (requestedPageSize !== FIXED_PAGE_SIZE) {
		throw new Response("pageSize 固定为 20", { status: 400 });
	}
	const pageSize = FIXED_PAGE_SIZE;
	const requestedPage = parsePositiveInt(url.searchParams.get("page")) ?? 1;
	const where: string[] = ["p.area_id = ?", "p.deleted_at IS NULL"];
	const whereArgs: Array<string | number> = [areaId];
	if (!canSeeHidden) {
		where.push("p.is_hidden = 0");
	}
	if (q) {
		where.push("(p.title LIKE ? OR p.content LIKE ?)");
		const pattern = `%${q}%`;
		whereArgs.push(pattern, pattern);
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

	let countRow: { count: number | string } | null = null;
	try {
		countRow = await queryOne<{ count: number | string }>(db, `SELECT COUNT(1) as count FROM posts p ${whereSql}`, whereArgs);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such column") && message.includes("is_hidden")) {
			const fallbackWhere = where.filter((w) => w !== "p.is_hidden = 0");
			const fallbackArgs = whereArgs;
			const fallbackSql = fallbackWhere.length > 0 ? `WHERE ${fallbackWhere.join(" AND ")}` : "";
			countRow = await queryOne<{ count: number | string }>(db, `SELECT COUNT(1) as count FROM posts p ${fallbackSql}`, fallbackArgs);
		} else {
			throw error;
		}
	}
	const totalCount = Number(countRow?.count ?? 0);
	const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
	if (requestedPage > totalPages) {
		throw new Response(`页码超出范围（总页数：${totalPages}）`, { status: 400 });
	}
	const page = requestedPage;
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
	let rows: PostDbRow[] = [];
	try {
		rows = await queryAll<PostDbRow>(
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
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such column") && message.includes("is_hidden")) {
			const fallbackWhere = where.filter((w) => w !== "p.is_hidden = 0");
			const fallbackSql = fallbackWhere.length > 0 ? `WHERE ${fallbackWhere.join(" AND ")}` : "";
			rows = await queryAll<PostDbRow>(
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
				 ${fallbackSql}
				 ORDER BY (CASE WHEN p.pinned_until_ms = 0 OR p.pinned_until_ms > ? THEN 1 ELSE 0 END) DESC,
				          p.pinned_at DESC,
				          p.created_at DESC
				 LIMIT ? OFFSET ?`,
				[...whereArgs, now, pageSize, offset],
			);
		} else {
			throw error;
		}
	}
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

	return json<LoaderData>(
		{
		user,
		area,
		posts,
		canPost,
		q,
		page,
		pageSize,
		totalCount,
		totalPages,
		},
		{ headers: { "Cache-Control": "private, max-age=30" } },
	);
}

export default function AreaPostsPage() {
	const data = useLoaderData<typeof loader>();
	const navigation = useNavigation();
	const now = Date.now();
	const hasPrev = data.page > 1;
	const hasNext = data.page < data.totalPages;
	const isLoading = navigation.state !== "idle";
	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex flex-col gap-2">
					{isLoading ? (
						<div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:border-blue-900/50 dark:bg-blue-900/20 dark:text-blue-200">
							正在加载…
						</div>
					) : null}
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
						<div className="flex flex-col items-end gap-2">
							{data.user ? (
								data.canPost ? (
									<Link
										to={`/posts/new?areaId=${data.area.id}`}
										className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
									>
										发帖
									</Link>
								) : (
									<span className="text-xs text-gray-500 dark:text-gray-400">当前讨论区不可发帖</span>
								)
							) : (
								<Link to={`/posts/new?areaId=${data.area.id}`} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
									登录后发帖
								</Link>
							)}
							<Link to="/posts" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
								返回讨论区列表
							</Link>
						</div>
					</div>
					<Form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-center">
						<input
							name="q"
							defaultValue={data.q}
							placeholder="搜索标题或内容"
							className="w-full flex-1 rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
						/>
						<button
							type="submit"
							disabled={navigation.state === "submitting"}
							className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
						>
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
								prefetch="intent"
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
								prefetch="intent"
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

	const match = location.pathname.match(/^\/areas\/(\d+)/);
	const fallbackTo = match ? `/areas/${match[1]}` : "/posts";
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
