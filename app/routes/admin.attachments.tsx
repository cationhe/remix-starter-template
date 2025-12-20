import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { assertAdmin, assertNotBanned, requireUser } from "~/lib/auth.server";
import { getDBFromContext, queryAll } from "~/lib/d1.server";
import { removeAttachmentRecord } from "~/lib/attachments.server";

type AttachmentListItem = {
	id: number;
	postId: number;
	postTitle: string;
	uploaderId: number;
	uploaderName: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: number;
};

type ActionData = {
	formError?: string;
};

function parseId(value: FormDataEntryValue | null) {
	const raw = typeof value === "string" ? value : "";
	const id = Number(raw);
	if (!raw || Number.isNaN(id) || !Number.isFinite(id) || id <= 0) {
		return null;
	}
	return Math.floor(id);
}

function formatSize(bytes: number) {
	if (!Number.isFinite(bytes) || bytes < 0) return "-";
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1)} MB`;
	const gb = mb / 1024;
	return `${gb.toFixed(2)} GB`;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	assertAdmin(me);

	const db = getDBFromContext(context);
	const attachments = await queryAll<AttachmentListItem>(
		db,
		"SELECT attachments.id as id, attachments.post_id as postId, posts.title as postTitle, attachments.uploader_id as uploaderId, users.display_name as uploaderName, attachments.filename as filename, attachments.mime_type as mimeType, attachments.size_bytes as sizeBytes, attachments.created_at as createdAt FROM attachments JOIN posts ON attachments.post_id = posts.id JOIN users ON attachments.uploader_id = users.id ORDER BY attachments.created_at DESC LIMIT 200",
	);
	return json({ me, attachments });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	assertAdmin(me);

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "");
	if (intent !== "delete") {
		return json<ActionData>({ formError: "未知操作" }, { status: 400 });
	}
	const attachmentId = parseId(formData.get("attachmentId"));
	if (!attachmentId) {
		return json<ActionData>({ formError: "无效的附件ID" }, { status: 400 });
	}
	try {
		await removeAttachmentRecord(context, attachmentId);
		return redirect("/admin/attachments");
	} catch (error) {
		if (error instanceof Response) {
			return json<ActionData>({ formError: await error.text() }, { status: error.status });
		}
		return json<ActionData>({ formError: "删除失败，请稍后重试" }, { status: 500 });
	}
}

export default function AdminAttachmentsPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-5xl flex-col gap-6">
				<header className="flex items-center justify-between">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">附件管理</h1>
					<div className="flex items-center gap-2">
						<Link
							to="/admin/users"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							用户管理
						</Link>
						<Link
							to="/posts"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							返回论坛
						</Link>
					</div>
				</header>

				{actionData?.formError ? (
					<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						{actionData.formError}
					</div>
				) : null}

				<div className="overflow-hidden rounded-xl bg-white shadow dark:bg-gray-800">
					<table className="w-full table-auto text-left text-sm">
						<thead className="bg-gray-100 text-xs text-gray-600 dark:bg-gray-900/30 dark:text-gray-300">
							<tr>
								<th className="px-4 py-3">ID</th>
								<th className="px-4 py-3">文件名</th>
								<th className="px-4 py-3">大小</th>
								<th className="px-4 py-3">帖子</th>
								<th className="px-4 py-3">上传者</th>
								<th className="px-4 py-3">时间</th>
								<th className="px-4 py-3">操作</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-200 dark:divide-gray-700">
							{data.attachments.map((a) => (
								<tr key={a.id} className="text-gray-900 dark:text-gray-100">
									<td className="px-4 py-3">{a.id}</td>
									<td className="px-4 py-3 break-all text-gray-700 dark:text-gray-200">
										<div className="font-medium text-gray-900 dark:text-gray-100">{a.filename}</div>
										<div className="text-xs text-gray-500 dark:text-gray-400">{a.mimeType}</div>
									</td>
									<td className="px-4 py-3 text-gray-700 dark:text-gray-200">{formatSize(a.sizeBytes)}</td>
									<td className="px-4 py-3">
										<Link to={`/posts/${a.postId}`} className="text-blue-600 hover:underline dark:text-blue-400">
											{a.postTitle}
										</Link>
									</td>
									<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
										{a.uploaderName}（{a.uploaderId}）
									</td>
									<td className="px-4 py-3 text-gray-700 dark:text-gray-200">{new Date(a.createdAt).toLocaleString()}</td>
									<td className="px-4 py-3">
										<Form
											method="post"
											onSubmit={(e) => {
												const ok = window.confirm(`确认删除附件吗？\n\n文件：${a.filename}`);
												if (!ok) e.preventDefault();
											}}
										>
											<input type="hidden" name="intent" value="delete" />
											<input type="hidden" name="attachmentId" value={a.id} />
											<button
												type="submit"
												className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
											>
												删除
											</button>
										</Form>
									</td>
								</tr>
							))}
							{data.attachments.length === 0 ? (
								<tr>
									<td className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400" colSpan={7}>
										暂无附件记录
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}

