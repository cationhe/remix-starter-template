import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { getDBFromContext, execute } from "~/lib/d1.server";
import { assertNotBanned, requireUser } from "~/lib/auth.server";

type ActionData = {
	fieldErrors?: {
		title?: string;
		content?: string;
	};
	formError?: string;
};

export async function loader({ request, context }: LoaderFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);
	return json({});
}

export async function action({ request, context }: ActionFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);
	const formData = await request.formData();
	const title = String(formData.get("title") || "").trim();
	const content = String(formData.get("content") || "").trim();
	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!title) {
		fieldErrors.title = "请输入标题";
	}
	if (!content) {
		fieldErrors.content = "请输入内容";
	}
	if (fieldErrors.title || fieldErrors.content) {
		return json<ActionData>({ fieldErrors }, { status: 400 });
	}
	try {
		const db = getDBFromContext(context);
		const createdAt = Date.now();
		await execute(
			db,
			"INSERT INTO posts (title, content, author_id, created_at) VALUES (?, ?, ?, ?)",
			[title, content, user.id, createdAt],
		);
		return redirect("/posts");
	} catch (error) {
		return json<ActionData>({ formError: "发帖失败，请稍后重试" }, { status: 500 });
	}
}

export default function NewPost() {
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="w-full max-w-2xl rounded-xl bg-white p-8 shadow dark:bg-gray-800">
				<h1 className="mb-6 text-center text-2xl font-semibold text-gray-900 dark:text-gray-100">
					发布新帖子
				</h1>
				<Form method="post" className="space-y-5">
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
							标题
						</label>
						<input
							name="title"
							required
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.title ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.title}</p>
						) : null}
					</div>
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
							内容
						</label>
						<textarea
							name="content"
							rows={8}
							required
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.content ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.content}</p>
						) : null}
					</div>
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
							disabled={isSubmitting}
							className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
						>
							{isSubmitting ? "发布中..." : "发布"}
						</button>
					</div>
				</Form>
			</div>
		</div>
	);
}
