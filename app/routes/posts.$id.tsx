import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { getDBFromContext, queryAll, queryOne, execute } from "~/lib/d1.server";
import { getSession } from "~/lib/session.server";
import { assertNotBanned, findUserById, requireUser } from "~/lib/auth.server";

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
	authorName: string;
};

type LoaderData = {
	user: Awaited<ReturnType<typeof findUserById>>;
	post: PostDetail;
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
		"SELECT comments.id as id, comments.content as content, comments.created_at as createdAt, users.display_name as authorName FROM comments JOIN users ON comments.author_id = users.id WHERE comments.post_id = ? ORDER BY comments.created_at ASC LIMIT ? OFFSET ?",
		[id, pageSize, offset],
	);

	return json<LoaderData>({
		user,
		post,
		comments,
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
					<div className="flex items-center gap-3 text-sm">
						{data.user ? (
							<>
								<span className="text-gray-700 dark:text-gray-200">
									已登录：{data.user.displayName}
								</span>
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
				<main className="flex flex-col gap-6">
					{isBanned ? (
						<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
							账号已被封禁，无法删帖、点赞或发表评论。
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
