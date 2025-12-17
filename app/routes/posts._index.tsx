import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useLoaderData } from "@remix-run/react";
import { getDBFromContext, queryAll } from "~/lib/d1.server";
import { getSession } from "~/lib/session.server";
import { findUserById } from "~/lib/auth.server";

type PostListItem = {
	id: number;
	title: string;
	createdAt: number;
	authorName: string;
};

type LoaderData = {
	user: Awaited<ReturnType<typeof findUserById>>;
	posts: PostListItem[];
};

export async function loader({ request, context }: LoaderFunctionArgs) {
	const session = await getSession(request, context);
	const userId = session.get("userId") as number | undefined;
	let user: Awaited<ReturnType<typeof findUserById>> = null;
	if (userId) {
		user = await findUserById(context, userId);
	}
	const db = getDBFromContext(context);
	const posts = await queryAll<PostListItem>(
		db,
		"SELECT posts.id as id, posts.title as title, posts.created_at as createdAt, users.display_name as authorName FROM posts JOIN users ON posts.author_id = users.id ORDER BY posts.created_at DESC LIMIT 50",
	);
	return json<LoaderData>({ user, posts });
}

export default function PostsIndex() {
	const data = useLoaderData<typeof loader>();
	const isBanned = Boolean(data.user?.isBanned);
	const showAdmin = Boolean(
		data.user && (data.user.role === "admin" || data.user.role === "superadmin"),
	);
	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex items-center justify-between">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
						帖子列表
					</h1>
						<div className="flex items-center gap-3 text-sm">
							{data.user ? (
								<>
									<span className="text-gray-700 dark:text-gray-200">
										已登录：{data.user.displayName}
									</span>
									{showAdmin ? (
										<a
											href="/admin/users"
											className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										>
											用户管理
										</a>
									) : null}
									<a
										href="/logout"
										className="rounded bg-gray-800 px-3 py-1 text-white hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
									>
										退出登录
									</a>
								</>
							) : (
							<>
								<a
									href="/login"
									className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700"
								>
									登录
								</a>
								<a
									href="/register"
									className="rounded bg-green-600 px-3 py-1 text-white hover:bg-green-700"
								>
									注册
								</a>
							</>
						)}
					</div>
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
						<Link
							to="/posts/new"
							className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
						>
							发新帖
						</Link>
					) : (
						<span className="text-xs text-gray-500 dark:text-gray-400">
							{data.user ? "封禁账号不可发帖" : "登录后可以发帖"}
						</span>
					)}
				</div>
				<div className="rounded-xl bg-white shadow dark:bg-gray-800">
					{data.posts.length === 0 ? (
						<p className="p-6 text-sm text-gray-600 dark:text-gray-300">
							还没有任何帖子，快来发布第一篇吧。
						</p>
					) : (
						<ul className="divide-y divide-gray-200 dark:divide-gray-700">
							{data.posts.map((post) => (
								<li key={post.id} className="px-6 py-4">
									<Link
										to={`/posts/${post.id}`}
										className="text-base font-medium text-blue-700 hover:underline dark:text-blue-400"
									>
										{post.title}
									</Link>
									<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
										<span>作者：{post.authorName}</span>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
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
