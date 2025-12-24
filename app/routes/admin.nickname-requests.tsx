import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useMemo } from "react";
import { assertAdmin, assertNotBanned, getClientIp, requireUser } from "~/lib/auth.server";
import { execute, getDBFromContext, queryOne } from "~/lib/d1.server";
import { sendMessage } from "~/lib/messages.server";
import { listPendingNicknameRequests, reviewNicknameChangeRequest, validateDisplayName } from "~/lib/nickname.server";

type LoaderData = {
	me: { id: number; role: string; displayName: string };
	requests: Awaited<ReturnType<typeof listPendingNicknameRequests>>;
};

type ActionData = {
	formError?: string;
};

function parseId(value: FormDataEntryValue | null) {
	const raw = String(value || "").trim();
	const num = Number(raw);
	if (!raw || Number.isNaN(num) || !Number.isFinite(num) || num <= 0) return null;
	return Math.floor(num);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	assertAdmin(me);
	if (me.role !== "superadmin" && me.role !== "topadmin") {
		throw redirect("/");
	}

	const requests = await listPendingNicknameRequests(context, 200);
	return json<LoaderData>({ me: { id: me.id, role: me.role, displayName: me.displayName }, requests });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	assertAdmin(me);
	if (me.role !== "superadmin" && me.role !== "topadmin") {
		return json<ActionData>({ formError: "只有超级管理员可以审批" }, { status: 403 });
	}

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "").trim();
	const requestId = parseId(formData.get("requestId"));
	if (!requestId) {
		return json<ActionData>({ formError: "无效的申请ID" }, { status: 400 });
	}

	const approved = intent === "approve";
	const rejected = intent === "reject";
	if (!approved && !rejected) {
		return json<ActionData>({ formError: "未知操作" }, { status: 400 });
	}

	const reviewNoteRaw = String(formData.get("reviewNote") || "").trim();
	const reviewNote = reviewNoteRaw ? reviewNoteRaw.slice(0, 200) : null;
	const now = Date.now();
	const ip = getClientIp(request);
	const userAgent = request.headers.get("User-Agent");
	const db = getDBFromContext(context);

	const row = await queryOne<{
		id: number;
		userId: number;
		desiredDisplayName: string;
		currentDisplayName: string;
		status: string;
	}> (
		db,
		"SELECT id as id, user_id as userId, desired_display_name as desiredDisplayName, current_display_name as currentDisplayName, status as status FROM nickname_change_requests WHERE id = ?",
		[requestId],
	);
	if (!row || row.status !== "pending") {
		return json<ActionData>({ formError: "申请不存在或已处理" }, { status: 400 });
	}

	if (approved) {
		const validated = validateDisplayName(row.desiredDisplayName);
		if (!validated.ok) {
			return json<ActionData>({ formError: `该申请昵称不合法：${validated.error}` }, { status: 400 });
		}
	}

	const reviewed = await reviewNicknameChangeRequest({
		context,
		requestId,
		approved,
		reviewedBy: me.id,
		reviewNote,
		now,
	});
	if (!reviewed.ok) {
		return json<ActionData>({ formError: reviewed.error }, { status: reviewed.status });
	}

	try {
		await execute(
			db,
			"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			[
				me.id,
				approved ? "nickname_change_request_approved" : "nickname_change_request_rejected",
				ip,
				userAgent,
				JSON.stringify({ requestId, targetUserId: row.userId, from: row.currentDisplayName, to: row.desiredDisplayName, reviewNote }),
				now,
			],
		);
	} catch {
	}

	if (row.userId !== me.id) {
		const content =
			"昵称修改申请结果\n" +
			`申请ID：${requestId}\n` +
			`当前昵称：${row.currentDisplayName}\n` +
			`申请昵称：${row.desiredDisplayName}\n` +
			`审批结果：${approved ? "通过" : "驳回"}\n` +
			(reviewNote ? `备注：${reviewNote}\n` : "") +
			`审批时间：${new Date(now).toLocaleString()}`;
		try {
			await sendMessage(context, { sender: me, recipientId: row.userId, content });
		} catch {
		}
	}

	return redirect("/admin/nickname-requests");
}

export default function AdminNicknameRequestsPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<typeof action>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state !== "idle";
	const requests = data.requests;

	const createdText = useMemo(() => {
		return (createdAt: number) => {
			try {
				return new Date(createdAt).toLocaleString();
			} catch {
				return String(createdAt);
			}
		};
	}, []);

	return (
		<div className="mx-auto w-full max-w-5xl px-4 py-8">
			<div className="mb-6 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">昵称审批</h1>
					<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
						仅展示待审批申请，审批后会通知申请人。
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Link
						to="/admin/users"
						className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
					>
						用户管理
					</Link>
				</div>
			</div>

			{actionData?.formError ? (
				<div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
					{actionData.formError}
				</div>
			) : null}

			<div className="rounded-xl border border-gray-200 bg-white shadow dark:border-gray-800 dark:bg-gray-900">
				<div className="border-b border-gray-200 px-4 py-3 text-sm font-medium text-gray-900 dark:border-gray-800 dark:text-gray-100">
					待审批：{requests.length} 条
				</div>
				{requests.length === 0 ? (
					<div className="px-4 py-10 text-center text-sm text-gray-600 dark:text-gray-300">暂无待审批申请</div>
				) : (
					<div className="divide-y divide-gray-200 dark:divide-gray-800">
						{requests.map((r) => (
							<div key={r.id} className="px-4 py-4">
								<div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
									<div className="min-w-0">
										<div className="text-sm font-medium text-gray-900 dark:text-gray-100">
											申请ID：{r.id}，用户ID：{r.userId}
										</div>
										<div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
											{r.userEmail}（{r.userRole}）
										</div>
										<div className="mt-2 text-sm text-gray-900 dark:text-gray-100">
											<span className="font-medium">{r.currentDisplayName}</span>
											<span className="mx-2 text-gray-500 dark:text-gray-400">→</span>
											<span className="font-medium">{r.desiredDisplayName}</span>
										</div>
										<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
											提交时间：{createdText(r.createdAt)}
										</div>
									</div>
									<div className="w-full md:w-[26rem]">
										<Form method="post" className="flex flex-col gap-2">
											<input type="hidden" name="requestId" value={r.id} />
											<label className="text-xs text-gray-600 dark:text-gray-300">
												备注（可选）
												<input
													name="reviewNote"
													disabled={isSubmitting}
													maxLength={200}
													className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
													placeholder="例如：请避免使用敏感词"
												/>
											</label>
											<div className="flex items-center gap-2">
												<button
													name="intent"
													value="approve"
													disabled={isSubmitting}
													className={
														isSubmitting
															? "rounded bg-green-200 px-4 py-2 text-sm font-medium text-green-900/60 dark:bg-green-900/30 dark:text-green-200/60"
														: "rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
													}
												>
													通过
												</button>
												<button
													name="intent"
													value="reject"
													disabled={isSubmitting}
													className={
														isSubmitting
															? "rounded bg-red-200 px-4 py-2 text-sm font-medium text-red-900/60 dark:bg-red-900/30 dark:text-red-200/60"
														: "rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
													}
												>
													驳回
												</button>
											</div>
										</Form>
									</div>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
