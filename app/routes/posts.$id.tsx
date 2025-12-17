import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { getDBFromContext, queryAll, queryOne, execute } from "~/lib/d1.server";
import { getSession } from "~/lib/session.server";
import { findUserById } from "~/lib/auth.server";

type PostDetail = {
	id: number;
	title: string;
	content: string;
	createdAt: number;
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
};

type ActionData = {
	fieldErrors?: {
		content?: string;
	};
	formError?: string;
};

export async function loader({ request, context, params }: LoaderFunctionArgs) {
	const session = await getSession(request, context);
	const userId = session.get("userId") as number | undefined;
	let user: Awaited<ReturnType<typeof findUserById>> = null;
	if (userId) {
		user = await findUserById(context, userId);
	}
	const rawId = params.id;
	const id = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(id)) {
		throw new Response("无效的帖子ID", { status: 400 });
	}
	const db = getDBFromContext(context);
	const post = await queryOne<PostDetail>(
		db,
		"SELECT posts.id as id, posts.title as title, posts.content as content, posts.created_at as createdAt, users.display_name as authorName FROM posts JOIN users ON posts.author_id = users.id WHERE posts.id = ?",
		[id],
	);
	if (!post) {
		throw new Response("帖子不存在", { status: 404 });
	}
	const comments = await queryAll<CommentItem>(
		db,
		"SELECT comments.id as id, comments.content as content, comments.created_at as createdAt, users.display_name as authorName FROM comments JOIN users ON comments.author_id = users.id WHERE comments.post_id = ? ORDER BY comments.created_at ASC",
		[id],
	);
	return json<LoaderData>({ user, post, comments });
}

export async function action({ request, context, params }: ActionFunctionArgs) {
	const session = await getSession(request, context);
	const userId = session.get("userId") as number | undefined;
	if (!userId) {
		return redirect("/login");
	}
	const rawId = params.id;
	const postId = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(postId)) {
		return json<ActionData>({ formError: "无效的帖子ID" }, { status: 400 });
	}
	const formData = await request.formData();
	const content = String(formData.get("content") || "").trim();
	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!content) {
		fieldErrors.content = "请输入评论内容";
	}
	if (fieldErrors.content) {
		return json<ActionData>({ fieldErrors }, { status: 400 });
	}
	try {
		const db = getDBFromContext(context);
		const createdAt = Date.now();
		await execute(
			db,
			"INSERT INTO comments (post_id, content, author_id, created_at) VALUES (?, ?, ?, ?)",
			[postId, content, userId, createdAt],
		);
		return redirect(`/posts/${postId}`);
	} catch (error) {
		return json<ActionData>({ formError: "发表评论失败，请稍后重试" }, { status: 500 });
	}
}

export default function PostDetailPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
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
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<div className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800 dark:text-gray-100">
							{data.post.content}
						</div>
					</section>
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
							评论
						</h2>
						{data.comments.length === 0 ? (
							<p className="text-sm text-gray-600 dark:text-gray-300">
								还没有任何评论。
							</p>
						) : (
							<ul className="space-y-4">
								{data.comments.map((comment) => (
									<li key={comment.id} className="border-b border-gray-200 pb-3 last:border-none last:pb-0 dark:border-gray-700">
										<div className="text-sm text-gray-800 dark:text-gray-100">
											{comment.content}
										</div>
										<p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
											<span>作者：{comment.authorName}</span>
											<span className="ml-3">
												时间：{new Date(comment.createdAt).toLocaleString()}
											</span>
										</p>
									</li>
								))}
							</ul>
						)}
					</section>
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
							发表评论
						</h2>
						{data.user ? (
							<Form method="post" className="space-y-4">
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
									<Link
										to="/posts"
										className="text-sm text-gray-600 hover:underline dark:text-gray-300"
									>
										返回列表
									</Link>
									<button
										type="submit"
										disabled={isSubmitting}
										className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
									>
										{isSubmitting ? "提交中..." : "提交评论"}
									</button>
								</div>
							</Form>
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

