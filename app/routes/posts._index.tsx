import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useLoaderData } from "@remix-run/react";
import { getDBFromContext, queryAll } from "~/lib/d1.server";
import { getSession } from "~/lib/session.server";
import { findUserById } from "~/lib/auth.server";
import { getEffectiveDiscussionPermissionsForAreas, isDiscussionPermissionsReady } from "~/lib/discussion-permissions.server";

type PostListItem = {
	id: number;
	title: string;
	createdAt: number;
	authorName: string;
	isBanned: number;
	pinnedUntilMs: number | null;
	areaId: number;
};

type AreaListItem = {
	id: number;
	name: string;
	sortOrder: number;
	isHidden: number;
};

type AreaWithPosts = AreaListItem & {
	posts: PostListItem[];
};

type LoaderData = {
	user: Awaited<ReturnType<typeof findUserById>>;
	areas: AreaWithPosts[];
};

export async function loader({ request, context }: LoaderFunctionArgs) {
	const session = await getSession(request, context);
	const userId = session.get("userId") as number | undefined;
	let user: Awaited<ReturnType<typeof findUserById>> = null;
	if (userId) {
		user = await findUserById(context, userId);
	}
	const db = getDBFromContext(context);
	const now = Date.now();
	const canSeeHidden = user?.role === "superadmin" || user?.role === "topadmin";
	const areas = await queryAll<AreaListItem>(
		db,
		"SELECT id as id, name as name, sort_order as sortOrder, is_hidden as isHidden FROM discussion_areas ORDER BY sort_order ASC, id ASC",
	);
	const baseVisibleAreas = areas.filter((a) => canSeeHidden || !a.isHidden);
	let allowedAreaIds = new Set<number>(baseVisibleAreas.map((a) => a.id));
	if (user) {
		const permissionReady = await isDiscussionPermissionsReady(context);
		if (permissionReady) {
			const permMap = await getEffectiveDiscussionPermissionsForAreas(context, baseVisibleAreas.map((a) => a.id), user.role);
			allowedAreaIds = new Set<number>(baseVisibleAreas.filter((a) => permMap[a.id]?.canView).map((a) => a.id));
		}
	}
	let topPosts: (PostListItem & { rn: number })[] = [];
	try {
		topPosts = await queryAll<PostListItem & { rn: number }>(
			db,
			`SELECT id, title, createdAt, authorName, isBanned, pinnedUntilMs, areaId
			 FROM (
				SELECT p.id as id,
				       p.title as title,
				       p.created_at as createdAt,
				       u.display_name as authorName,
				       p.is_banned as isBanned,
				       p.pinned_until_ms as pinnedUntilMs,
				       p.area_id as areaId,
				       ROW_NUMBER() OVER (
					PARTITION BY p.area_id
					ORDER BY (CASE WHEN p.pinned_until_ms = 0 OR p.pinned_until_ms > ? THEN 1 ELSE 0 END) DESC,
					         p.pinned_at DESC,
					         p.created_at DESC
				       ) as rn
				FROM posts p
				JOIN users u ON p.author_id = u.id
				WHERE p.deleted_at IS NULL
				  AND (? = 1 OR p.is_hidden = 0)
			 )
			 WHERE rn <= 5`,
			[now, canSeeHidden ? 1 : 0],
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such column") && message.includes("is_hidden")) {
			topPosts = await queryAll<PostListItem & { rn: number }>(
				db,
				`SELECT id, title, createdAt, authorName, isBanned, pinnedUntilMs, areaId
				 FROM (
					SELECT p.id as id,
					       p.title as title,
					       p.created_at as createdAt,
					       u.display_name as authorName,
					       p.is_banned as isBanned,
					       p.pinned_until_ms as pinnedUntilMs,
					       p.area_id as areaId,
					       ROW_NUMBER() OVER (
						PARTITION BY p.area_id
						ORDER BY (CASE WHEN p.pinned_until_ms = 0 OR p.pinned_until_ms > ? THEN 1 ELSE 0 END) DESC,
						         p.pinned_at DESC,
						         p.created_at DESC
					       ) as rn
					FROM posts p
					JOIN users u ON p.author_id = u.id
					WHERE p.deleted_at IS NULL
				 )
				 WHERE rn <= 5`,
				[now],
			);
		} else {
			throw error;
		}
	}
	const byArea = new Map<number, PostListItem[]>();
	for (const row of topPosts) {
		if (!allowedAreaIds.has(row.areaId)) continue;
		const list = byArea.get(row.areaId) ?? [];
		list.push({
			id: row.id,
			title: row.title,
			createdAt: row.createdAt,
			authorName: row.authorName,
			isBanned: row.isBanned,
			pinnedUntilMs: row.pinnedUntilMs,
			areaId: row.areaId,
		});
		byArea.set(row.areaId, list);
	}
	const visibleAreas = baseVisibleAreas.filter((a) => allowedAreaIds.has(a.id));
	const merged: AreaWithPosts[] = visibleAreas.map((a) => ({
		...a,
		posts: byArea.get(a.id) ?? [],
	}));
	return json<LoaderData>({ user, areas: merged });
}

export default function PostsIndex() {
	const data = useLoaderData<typeof loader>();
	const isBanned = Boolean(data.user?.isBanned);
	const now = Date.now();
	return (
		<div className="px-6 py-8">
			<div className="mx-auto flex max-w-6xl flex-col gap-6">
				<header className="flex items-center justify-between">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
						帖子列表
					</h1>
					{data.user ? (
						<div className="flex flex-wrap items-center gap-2">
							<Link
								to="/messages"
								className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
							>
								消息中心
							</Link>
							<Link
								to="/me"
								className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
							>
								个人中心
							</Link>
						</div>
					) : null}
				</header>
				{isBanned ? (
					<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						账号已被封禁，无法发帖。
					</div>
				) : null}
				<div className="flex items-center justify-between">
					<p className="text-sm text-gray-600 dark:text-gray-300">
						在这里可以查看论坛中的帖子。
					</p>
					{data.user && !isBanned ? (
						<form action="/posts/new" method="get" className="flex flex-wrap items-center justify-end gap-2">
							<label htmlFor="newPostAreaId" className="text-sm text-gray-600 dark:text-gray-300">
								选择讨论区
							</label>
							<select
								id="newPostAreaId"
								name="areaId"
								required
								defaultValue={data.areas[0]?.id ?? ""}
								disabled={data.areas.length === 0}
								className="rounded border border-gray-300 bg-white px-3 py-1 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
							>
								{data.areas.map((a) => (
									<option key={a.id} value={a.id}>
										{a.name}
									</option>
								))}
							</select>
							<button
								type="submit"
								disabled={data.areas.length === 0}
								className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
							>
								发新帖
							</button>
						</form>
					) : (
						<span className="text-xs text-gray-500 dark:text-gray-400">
							{data.user ? "封禁账号不可发帖" : "登录后可以发帖"}
						</span>
					)}
				</div>
				{data.areas.length === 0 ? (
					<div className="rounded-xl bg-white p-6 text-sm text-gray-600 shadow dark:bg-gray-800 dark:text-gray-300">
						暂无讨论区。
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{data.areas.map((area) => (
							<section key={area.id} className="overflow-hidden rounded-xl bg-white/80 backdrop-blur-sm shadow-md ring-1 ring-slate-900/5 transition-all hover:shadow-lg dark:bg-slate-800/80 dark:ring-slate-100/10">
								<div className="flex items-center justify-between px-6 py-4">
									<div className="flex items-center gap-2">
										<h2
											className="text-lg font-bold"
											style={{
												fontFamily: '"Songti SC", "SimSun", "STSong", serif',
												fontWeight: 700,
												fontSize: "1.125rem",
												color: "#7c2d12",
												backgroundColor: "#e0f2fe",
												padding: "2px 8px",
												borderRadius: "8px",
											}}
										>
											<Link
												to={`/areas/${area.id}`}
												className="text-blue-700 hover:underline dark:text-blue-400"
											>
												{area.name}
											</Link>
										</h2>
										{area.isHidden ? (
											<span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-100">
												隐藏
											</span>
										) : null}
									</div>
									<span className="text-xs text-gray-500 dark:text-gray-400">仅展示最新 5 帖</span>
								</div>
								{area.posts.length === 0 ? (
									<p className="px-6 pb-6 text-sm text-gray-600 dark:text-gray-300">暂无帖子</p>
								) : (
									<ul className="divide-y divide-gray-200 dark:divide-gray-700">
										{area.posts.map((post) => {
											const pinned =
												post.pinnedUntilMs === 0 ||
												(typeof post.pinnedUntilMs === "number" && post.pinnedUntilMs > now);
											const banned = Boolean(post.isBanned);
											return (
												<li
													key={post.id}
													className={
														pinned
															? "bg-amber-50/60 px-6 py-4 dark:bg-amber-900/10"
															: "px-6 py-4"
													}
												>
													<Link
														to={`/posts/${post.id}`}
														className="text-base font-medium text-blue-700 hover:underline dark:text-blue-400"
													>
														{post.title}
													</Link>
													<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
														<span>作者：{post.authorName}</span>
														{pinned ? (
															<span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
																置顶
															</span>
														) : null}
														{banned ? (
															<span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-200">
																已封禁
															</span>
														) : null}
													</div>
												</li>
											);
										})}
									</ul>
								)}
							</section>
						))
						}
					</div>
				)}
				<div>
					<Link
						to="/"
						className="text-sm text-blue-600 hover:underline dark:text-blue-400"
					>
						返回首页
					</Link>
				</div>
			</div>
		</div>
	);
}
