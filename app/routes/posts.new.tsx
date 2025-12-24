import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";
import { assertNotBanned, consumeDailyQuota, requireUser } from "~/lib/auth.server";

type AreaListItem = {
	id: number;
	name: string;
	isHidden: number;
};

type LoaderData = {
	areas: AreaListItem[];
};

type ActionData = {
	fields?: {
		areaId?: string;
		title?: string;
		content?: string;
	};
	fieldErrors?: {
		areaId?: string;
		title?: string;
		content?: string;
	};
	formError?: string;
};

export async function loader({ request, context }: LoaderFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);
	const db = getDBFromContext(context);
	const canSeeHidden = user.role === "superadmin" || user.role === "topadmin";
	const areas = await queryAll<AreaListItem>(
		db,
		canSeeHidden
			? "SELECT id as id, name as name, is_hidden as isHidden FROM discussion_areas ORDER BY sort_order ASC, id ASC"
			: "SELECT id as id, name as name, is_hidden as isHidden FROM discussion_areas WHERE is_hidden = 0 ORDER BY sort_order ASC, id ASC",
	);
	return json<LoaderData>({ areas });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);
	const formData = await request.formData();
	const title = String(formData.get("title") || "");
	const content = String(formData.get("content") || "");
	const areaIdRaw = String(formData.get("areaId") || "").trim();
	const trimmedTitle = title.trim();
	const trimmedContent = content.trim();
	const areaId = Number(areaIdRaw);
	const fields: ActionData["fields"] = {
		areaId: areaIdRaw,
		title,
		content,
	};
	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!areaIdRaw || Number.isNaN(areaId) || !Number.isFinite(areaId) || areaId <= 0) {
		fieldErrors.areaId = "请选择讨论区";
	}
	if (!trimmedTitle) {
		fieldErrors.title = "请输入标题";
	}
	if (!trimmedContent) {
		fieldErrors.content = "请输入内容";
	}
	if (fieldErrors.areaId || fieldErrors.title || fieldErrors.content) {
		return json<ActionData>({ fields, fieldErrors }, { status: 400 });
	}
	try {
		const db = getDBFromContext(context);
		const area = await queryOne<{ id: number; isHidden: number }>(
			db,
			"SELECT id as id, is_hidden as isHidden FROM discussion_areas WHERE id = ?",
			[Math.floor(areaId)],
		);
		if (!area) {
			return json<ActionData>({ fields, formError: "讨论区不存在" }, { status: 400 });
		}
		if (area.isHidden && user.role !== "superadmin" && user.role !== "topadmin") {
			return json<ActionData>({ fields, formError: "该讨论区已隐藏，无法发帖" }, { status: 403 });
		}
		const quota = await consumeDailyQuota({ context, request, user, kind: "post" });
		if (!quota.ok) {
			return json<ActionData>({ fields, formError: quota.message }, { status: quota.status });
		}
		const createdAt = Date.now();
		await execute(
			db,
			"INSERT INTO posts (title, content, author_id, created_at, area_id) VALUES (?, ?, ?, ?, ?)",
			[trimmedTitle, trimmedContent, user.id, createdAt, area.id],
		);
		return redirect("/posts");
	} catch (error) {
		return json<ActionData>({ fields, formError: "发帖失败，请稍后重试" }, { status: 500 });
	}
}

export default function NewPost() {
	const loaderData = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	const hasAreas = loaderData.areas.length > 0;
	const fallbackAreaId = hasAreas ? String(loaderData.areas[0].id) : "";
	const selectedAreaId = actionData?.fields?.areaId && actionData.fields.areaId !== "" ? actionData.fields.areaId : fallbackAreaId;
	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="w-full max-w-2xl rounded-xl bg-white p-8 shadow dark:bg-gray-800">
				<h1 className="mb-6 text-center text-2xl font-semibold text-gray-900 dark:text-gray-100">
					发布新帖子
				</h1>
				<Form method="post" className="space-y-5">
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
							讨论区
						</label>
						<select
							name="areaId"
							required
							defaultValue={selectedAreaId}
							className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						>
							<option value="" disabled>
								请选择讨论区
							</option>
							{loaderData.areas.map((a) => (
								<option key={a.id} value={a.id}>
									{a.name}{a.isHidden ? "（隐藏）" : ""}
								</option>
							))}
						</select>
						{!hasAreas ? (
							<p className="mt-1 text-xs text-red-600">暂无可发帖的讨论区，请联系管理员。</p>
						) : null}
						{actionData?.fieldErrors?.areaId ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.areaId}</p>
						) : null}
					</div>
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
							标题
						</label>
						<input
							name="title"
							required
							defaultValue={actionData?.fields?.title ?? ""}
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
							defaultValue={actionData?.fields?.content ?? ""}
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
							disabled={isSubmitting || !hasAreas}
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
