import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useLoaderData } from "@remix-run/react";
import { requireUser } from "~/lib/auth.server";
import { getDBFromContext, queryOne } from "~/lib/d1.server";

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	stats: {
		postCount: number;
		commentCount: number;
		likeCount: number;
	};
};

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	const db = getDBFromContext(context);

	const postCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM posts WHERE author_id = ?",
		[me.id],
	);
	const commentCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM comments WHERE author_id = ?",
		[me.id],
	);
	const likeCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM post_likes WHERE user_id = ?",
		[me.id],
	);

	return json<LoaderData>({
		me,
		stats: {
			postCount: Number(postCountRow?.count ?? 0),
			commentCount: Number(commentCountRow?.count ?? 0),
			likeCount: Number(likeCountRow?.count ?? 0),
		},
	});
}

export default function MePage() {
	const data = useLoaderData<typeof loader>();
	const me = data.me;
	const isBanned = Boolean(me.isBanned);

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex items-start justify-between gap-4">
					<div>
						<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
							个人中心
						</h1>
						<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
							{me.displayName}（{me.role}）
						</p>
						{isBanned ? (
							<p className="mt-2 text-sm text-red-600 dark:text-red-200">账号已被封禁</p>
						) : null}
					</div>
					<Link
						to="/posts"
						className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
					>
						返回论坛
					</Link>
				</header>

				<section className="overflow-hidden rounded-xl bg-white shadow dark:bg-gray-800">
					<div className="grid grid-cols-1 gap-0 divide-y divide-gray-200 dark:divide-gray-700 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
						<div className="p-5">
							<p className="text-xs text-gray-500 dark:text-gray-400">我的帖子</p>
							<p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
								{data.stats.postCount}
							</p>
						</div>
						<div className="p-5">
							<p className="text-xs text-gray-500 dark:text-gray-400">我的评论</p>
							<p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
								{data.stats.commentCount}
							</p>
						</div>
						<div className="p-5">
							<p className="text-xs text-gray-500 dark:text-gray-400">我的点赞</p>
							<p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
								{data.stats.likeCount}
							</p>
						</div>
					</div>
				</section>

				<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">账号信息</h2>
					<div className="mt-4 flex flex-wrap items-center gap-2">
						<Link
							to="/me/password"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							修改密码
						</Link>
					</div>
					<dl className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
						<div>
							<dt className="text-gray-500 dark:text-gray-400">邮箱</dt>
							<dd className="mt-1 break-all text-gray-900 dark:text-gray-100">{me.email}</dd>
						</div>
						<div>
							<dt className="text-gray-500 dark:text-gray-400">注册时间</dt>
							<dd className="mt-1 text-gray-900 dark:text-gray-100">
								{new Date(me.createdAt).toLocaleString()}
							</dd>
						</div>
						{me.bannedAt ? (
							<div>
								<dt className="text-gray-500 dark:text-gray-400">封禁时间</dt>
								<dd className="mt-1 text-gray-900 dark:text-gray-100">
									{new Date(me.bannedAt).toLocaleString()}
								</dd>
							</div>
						) : null}
					</dl>
				</section>
			</div>
		</div>
	);
}
