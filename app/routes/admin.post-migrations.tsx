import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useMemo, useState } from "react";
import { assertNotBanned, getClientIp, isSuperadmin, requireUser, verifyLogin } from "~/lib/auth.server";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";

type AreaListItem = {
	areaId: number;
	name: string;
	isHidden: number;
};

type PostRow = {
	id: number;
	areaId: number;
	title: string;
};

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	areas: AreaListItem[];
};

type PreviewData = {
	targetAreaId: number;
	postIds: number[];
	postCount: number;
	commentCount: number;
	postTitles: { id: number; title: string; areaId: number }[];
};

type ActionData = {
	formError?: string;
	preview?: PreviewData;
};

function parseId(value: FormDataEntryValue | null) {
	const raw = String(value || "").trim();
	const num = Number(raw);
	if (!raw || Number.isNaN(num) || !Number.isFinite(num)) return null;
	const id = Math.floor(num);
	if (id <= 0) return null;
	return id;
}

function parsePostIds(value: FormDataEntryValue | null) {
	const raw = String(value || "");
	const tokens = raw
		.split(/[\s,，]+/g)
		.map((t) => t.trim())
		.filter(Boolean);
	const ids = tokens
		.map((t) => Number(t))
		.filter((n) => Number.isFinite(n) && n > 0)
		.map((n) => Math.floor(n));
	const unique = Array.from(new Set(ids));
	return unique;
}

async function logEvent(args: {
	context: ActionFunctionArgs["context"];
	userId: number;
	eventType: string;
	ip: string | null;
	userAgent: string | null;
	metadata: Record<string, unknown>;
}) {
	try {
		await execute(
			getDBFromContext(args.context),
			"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			[args.userId, args.eventType, args.ip, args.userAgent, JSON.stringify(args.metadata), Date.now()],
		);
	} catch {
	}
}

async function getPreview(args: {
	context: ActionFunctionArgs["context"];
	targetAreaId: number;
	postIds: number[];
}) {
	const db = getDBFromContext(args.context);
	const placeholders = args.postIds.map(() => "?").join(",");
	const posts = await queryAll<PostRow>(
		db,
		`SELECT id as id, area_id as areaId, title as title FROM posts WHERE id IN (${placeholders})`,
		args.postIds,
	);
	const foundIds = new Set(posts.map((p) => p.id));
	const missing = args.postIds.filter((id) => !foundIds.has(id));
	if (missing.length > 0) {
		return { ok: false as const, error: `以下帖子不存在：${missing.join(", ")}` };
	}
	const commentRow = await queryOne<{ count: number | string }>(
		db,
		`SELECT COUNT(1) as count FROM comments WHERE post_id IN (${placeholders})`,
		args.postIds,
	);
	const commentCount = Number(commentRow?.count ?? 0);
	return {
		ok: true as const,
		preview: {
			targetAreaId: args.targetAreaId,
			postIds: args.postIds,
			postCount: args.postIds.length,
			commentCount,
			postTitles: posts.map((p) => ({ id: p.id, title: p.title, areaId: p.areaId })),
		},
	};
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (!isSuperadmin(me)) {
		throw new Response("只有超级管理员或站点管理员可访问", { status: 403 });
	}

	const db = getDBFromContext(context);
	const areas = await queryAll<AreaListItem>(
		db,
		"SELECT id as areaId, name as name, is_hidden as isHidden FROM discussion_areas ORDER BY sort_order ASC, id ASC",
	);
	return json<LoaderData>({ me, areas });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (!isSuperadmin(me)) {
		throw new Response("只有超级管理员或站点管理员可访问", { status: 403 });
	}

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "").trim();
	if (intent !== "previewMigration" && intent !== "executeMigration") {
		return json<ActionData>({ formError: "未知操作" }, { status: 400 });
	}
	const targetAreaId = parseId(formData.get("targetAreaId"));
	if (!targetAreaId) {
		return json<ActionData>({ formError: "请选择目标讨论区" }, { status: 400 });
	}
	const postIds = parsePostIds(formData.get("postIds"));
	if (postIds.length === 0) {
		return json<ActionData>({ formError: "请填写要迁移的帖子ID（可用逗号/换行分隔）" }, { status: 400 });
	}
	if (postIds.length > 200) {
		return json<ActionData>({ formError: "一次最多迁移 200 个帖子" }, { status: 400 });
	}
	const password = String(formData.get("password") || "").trim();
	if (!password) {
		return json<ActionData>({ formError: "需要二次验证密码" }, { status: 400 });
	}
	const verified = await verifyLogin(context, me.email, password);
	if (!verified || verified.id !== me.id) {
		return json<ActionData>({ formError: "二次验证失败" }, { status: 403 });
	}

	const db = getDBFromContext(context);
	const target = await queryOne<{ id: number }>(db, "SELECT id as id FROM discussion_areas WHERE id = ?", [targetAreaId]);
	if (!target) {
		return json<ActionData>({ formError: "目标讨论区不存在" }, { status: 404 });
	}

	const previewRes = await getPreview({ context, targetAreaId, postIds });
	if (!previewRes.ok) {
		return json<ActionData>({ formError: previewRes.error }, { status: 400 });
	}

	if (intent === "previewMigration") {
		return json<ActionData>({ preview: previewRes.preview });
	}

	const confirmed = String(formData.get("confirmed") || "").trim() === "1";
	if (!confirmed) {
		return json<ActionData>({ formError: "请先确认迁移" }, { status: 400 });
	}

	const now = Date.now();
	const placeholders = postIds.map(() => "?").join(",");
	const beforeRows = await queryAll<{ id: number; areaId: number }>(
		db,
		`SELECT id as id, area_id as areaId FROM posts WHERE id IN (${placeholders})`,
		postIds,
	);

	await execute(
		db,
		`UPDATE posts SET area_id = ?, updated_at = ? WHERE id IN (${placeholders})`,
		[targetAreaId, now, ...postIds],
	);

	const ip = getClientIp(request);
	const userAgent = request.headers.get("User-Agent");
	await logEvent({
		context,
		userId: me.id,
		eventType: "posts_migrated_to_area",
		ip,
		userAgent,
		metadata: {
			targetAreaId,
			postIds,
			postCount: previewRes.preview.postCount,
			commentCount: previewRes.preview.commentCount,
			beforeAreas: beforeRows,
		},
	});

	return redirect(`/admin/post-migrations?migrated=1&count=${previewRes.preview.postCount}`);
}

export default function AdminPostMigrationsPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state !== "idle";

	const [postIdsRaw, setPostIdsRaw] = useState("");
	const [targetAreaId, setTargetAreaId] = useState(() => String(data.areas.find((a) => a.areaId !== 1)?.areaId ?? 1));
	const [password, setPassword] = useState("");

	const preview = actionData?.preview ?? null;
	const previewText = useMemo(() => {
		if (!preview) return "";
		return `将迁移 ${preview.postCount} 个帖子，评论总数 ${preview.commentCount} 条。`;
	}, [preview]);

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<header className="flex items-center justify-between">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">帖子迁移</h1>
					<div className="flex items-center gap-2">
						<Link
							to="/admin/discussion-areas"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							讨论区管理
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

				<div className="rounded-xl bg-white p-5 shadow dark:bg-gray-800">
					<div className="text-sm text-gray-600 dark:text-gray-300">
						填写需要迁移的帖子 ID（可用逗号/空格/换行分隔），系统会把这些帖子移动到目标讨论区。评论会随帖子一起生效，无需单独处理。
					</div>
					<Form method="post" className="mt-4 flex flex-col gap-4">
						<input type="hidden" name="intent" value="previewMigration" />
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<div className="flex flex-col gap-2">
								<label className="text-sm font-medium text-gray-800 dark:text-gray-200">目标讨论区</label>
								<select
									name="targetAreaId"
									value={targetAreaId}
									onChange={(e) => setTargetAreaId(e.target.value)}
									className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
								>
									{data.areas.map((a) => (
										<option key={a.areaId} value={String(a.areaId)}>
											{a.name}{a.isHidden ? "（隐藏）" : ""}（ID {a.areaId}）
										</option>
									))}
								</select>
							</div>
							<div className="flex flex-col gap-2">
								<label className="text-sm font-medium text-gray-800 dark:text-gray-200">二次验证密码</label>
								<input
									type="password"
									name="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									placeholder="请输入你的账号密码"
									className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
								/>
							</div>
						</div>
						<div className="flex flex-col gap-2">
							<label className="text-sm font-medium text-gray-800 dark:text-gray-200">帖子 ID 列表</label>
							<textarea
								name="postIds"
								rows={5}
								value={postIdsRaw}
								onChange={(e) => setPostIdsRaw(e.target.value)}
								placeholder="例如：12, 34\n56"
								className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
							/>
						</div>
						<div className="flex items-center justify-end">
							<button
								type="submit"
								disabled={isSubmitting}
								className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
							>
								{isSubmitting ? "计算中..." : "迁移前预览"}
							</button>
						</div>
					</Form>
				</div>

				{preview ? (
					<div className="rounded-xl bg-white p-5 shadow dark:bg-gray-800">
						<div className="text-base font-semibold text-gray-900 dark:text-gray-100">迁移确认</div>
						<div className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
							{previewText}
						</div>
						<div className="mt-4 overflow-hidden rounded border border-gray-200 dark:border-gray-700">
							<table className="w-full table-auto text-left text-sm">
								<thead className="bg-gray-100 text-xs text-gray-600 dark:bg-gray-900/30 dark:text-gray-300">
									<tr>
										<th className="px-3 py-2">帖子ID</th>
										<th className="px-3 py-2">标题</th>
										<th className="px-3 py-2">原讨论区ID</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-200 dark:divide-gray-700">
									{preview.postTitles.map((p) => (
										<tr key={p.id} className="text-gray-900 dark:text-gray-100">
											<td className="px-3 py-2">{p.id}</td>
											<td className="px-3 py-2">{p.title}</td>
											<td className="px-3 py-2">{p.areaId}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<Form
							method="post"
							onSubmit={(e) => {
								const ok = window.confirm(`确认执行迁移吗？\n\n${previewText}`);
								if (!ok) e.preventDefault();
							}}
							className="mt-4 flex items-center justify-end"
						>
							<input type="hidden" name="intent" value="executeMigration" />
							<input type="hidden" name="targetAreaId" value={String(preview.targetAreaId)} />
							<input type="hidden" name="postIds" value={preview.postIds.join("\n")} />
							<input type="hidden" name="password" value={password} />
							<input type="hidden" name="confirmed" value="1" />
							<button
								type="submit"
								disabled={isSubmitting}
								className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-70"
							>
								{isSubmitting ? "迁移中..." : "确认迁移"}
							</button>
						</Form>
					</div>
				) : null}
			</div>
		</div>
	);
}
