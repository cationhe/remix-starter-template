import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useMemo } from "react";
import { assertAdmin, assertNotBanned, getClientIp, requireUser } from "~/lib/auth.server";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";

type UserRow = {
	id: number;
	email: string;
	displayName: string;
	role: string;
	isBanned: number;
	postCount: number;
	commentCount: number;
};

type ActiveOverrideRow = {
	id: number;
	userId: number;
	postLimit: number | null;
	commentLimit: number | null;
	startsAtMs: number;
	endsAtMs: number;
	createdBy: number;
	createdAt: number;
	reason: string | null;
};

type AuditLogRow = {
	id: number;
	userId: number;
	eventType: string;
	metadataJson: string | null;
	createdAt: number;
};

type AuditLogItem = {
	id: number;
	userId: number;
	eventType: string;
	createdAt: number;
	metadata: unknown;
};

type LoaderData = {
	me: { id: number; role: string; displayName: string };
	now: number;
	dayKey: number;
	dayEndMs: number;
	users: UserRow[];
	activeOverrides: ActiveOverrideRow[];
	auditLogs: AuditLogItem[];
};

type ActionData = {
	formError?: string;
};

function getChinaDayInfo(nowMs: number) {
	const offsetMs = 8 * 60 * 60 * 1000;
	const shifted = new Date(nowMs + offsetMs);
	const year = shifted.getUTCFullYear();
	const month = shifted.getUTCMonth() + 1;
	const day = shifted.getUTCDate();
	const dayKey = year * 10000 + month * 100 + day;
	const startMs = Date.UTC(year, month - 1, day) - offsetMs;
	const endMs = Date.UTC(year, month - 1, day + 1) - offsetMs - 1;
	return { dayKey, startMs, endMs };
}

function parseId(value: FormDataEntryValue | null) {
	const raw = String(value || "").trim();
	const num = Number(raw);
	if (!raw || Number.isNaN(num) || !Number.isFinite(num) || num <= 0) return null;
	return Math.floor(num);
}

function parseOptionalLimit(value: FormDataEntryValue | null) {
	const raw = String(value || "").trim();
	if (!raw) return null;
	const num = Number(raw);
	if (Number.isNaN(num) || !Number.isFinite(num) || num < 0) return null;
	return Math.floor(num);
}

function parseChinaDatetimeLocal(value: FormDataEntryValue | null) {
	const raw = String(value || "").trim();
	if (!raw) return null;
	const ms = Date.parse(`${raw}:00+08:00`);
	if (Number.isNaN(ms) || !Number.isFinite(ms)) return null;
	return ms;
}

function safeParseJson(value: string | null) {
	if (!value) return null;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	assertAdmin(me);

	const now = Date.now();
	const { dayKey, endMs } = getChinaDayInfo(now);
	const db = getDBFromContext(context);
	const users = await queryAll<UserRow>(
		db,
		"SELECT u.id as id, u.email as email, u.display_name as displayName, u.role as role, u.is_banned as isBanned, IFNULL(a.post_count, 0) as postCount, IFNULL(a.comment_count, 0) as commentCount FROM users u LEFT JOIN daily_user_activity a ON a.user_id = u.id AND a.day_key = ? WHERE u.deleted_at IS NULL ORDER BY u.id DESC LIMIT 200",
		[dayKey],
	);
	const activeOverrides = await queryAll<ActiveOverrideRow>(
		db,
		"SELECT id as id, user_id as userId, post_limit as postLimit, comment_limit as commentLimit, starts_at_ms as startsAtMs, ends_at_ms as endsAtMs, created_by as createdBy, created_at as createdAt, reason as reason FROM user_daily_quota_overrides WHERE revoked_at IS NULL AND starts_at_ms <= ? AND ends_at_ms >= ? ORDER BY created_at DESC, id DESC",
		[now, now],
	);
	const auditLogRows = await queryAll<AuditLogRow>(
		db,
		"SELECT id as id, user_id as userId, event_type as eventType, metadata_json as metadataJson, created_at as createdAt FROM security_audit_logs WHERE event_type IN (?, ?, ?, ?) ORDER BY created_at DESC, id DESC LIMIT 80",
		[
			"user_daily_quota_override_set",
			"user_daily_quota_override_revoked",
			"daily_quota_exceeded",
			"spam_rate_limited",
		],
	);
	return json<LoaderData>({
		me: { id: me.id, role: me.role, displayName: me.displayName },
		now,
		dayKey,
		dayEndMs: endMs,
		users,
		activeOverrides,
		auditLogs: auditLogRows.map((r) => ({
			id: r.id,
			userId: r.userId,
			eventType: r.eventType,
			createdAt: r.createdAt,
			metadata: safeParseJson(r.metadataJson),
		})),
	});
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	assertAdmin(me);

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "").trim();
	const db = getDBFromContext(context);
	const ip = getClientIp(request);
	const userAgent = request.headers.get("User-Agent");
	const now = Date.now();
	const { endMs } = getChinaDayInfo(now);

	if (intent === "setOverride") {
		const targetUserId = parseId(formData.get("userId"));
		if (!targetUserId) {
			return json<ActionData>({ formError: "无效的用户ID" }, { status: 400 });
		}
		const target = await queryOne<{ id: number; role: string }>(
			db,
			"SELECT id as id, role as role FROM users WHERE id = ? AND deleted_at IS NULL",
			[targetUserId],
		);
		if (!target) {
			return json<ActionData>({ formError: "用户不存在" }, { status: 404 });
		}
		if (target.role !== "user") {
			return json<ActionData>({ formError: "只能调整普通用户限额" }, { status: 400 });
		}
		const postLimit = parseOptionalLimit(formData.get("postLimit"));
		if (postLimit === null) {
			return json<ActionData>({ formError: "需要填写发帖上限（>=0）" }, { status: 400 });
		}
		const commentLimit = parseOptionalLimit(formData.get("commentLimit"));
		const mode = String(formData.get("period") || "today").trim();
		let startsAtMs: number | null = null;
		let endsAtMs: number | null = null;
		if (mode === "today") {
			startsAtMs = now;
			endsAtMs = endMs;
		} else {
			startsAtMs = parseChinaDatetimeLocal(formData.get("startsAt"));
			endsAtMs = parseChinaDatetimeLocal(formData.get("endsAt"));
		}
		if (startsAtMs === null || endsAtMs === null) {
			return json<ActionData>({ formError: "无效的有效期" }, { status: 400 });
		}
		if (endsAtMs < startsAtMs) {
			return json<ActionData>({ formError: "结束时间不能早于开始时间" }, { status: 400 });
		}
		const reason = String(formData.get("reason") || "").trim();
		try {
			await execute(
				db,
				"INSERT INTO user_daily_quota_overrides (user_id, post_limit, comment_limit, starts_at_ms, ends_at_ms, created_by, created_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				[targetUserId, postLimit, commentLimit, startsAtMs, endsAtMs, me.id, now, reason || null],
			);
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						me.id,
						"user_daily_quota_override_set",
						ip,
						userAgent,
						JSON.stringify({
							targetUserId,
							postLimit,
							commentLimit,
							startsAtMs,
							endsAtMs,
							reason: reason || null,
						}),
						now,
					],
				);
			} catch {
			}
			return redirect("/admin/quotas");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (message.includes("no such table") || message.includes("no such column")) {
				return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
			}
			return json<ActionData>({ formError: "保存失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "revokeOverride") {
		const overrideId = parseId(formData.get("overrideId"));
		if (!overrideId) {
			return json<ActionData>({ formError: "无效的记录ID" }, { status: 400 });
		}
		try {
			await execute(
				db,
				"UPDATE user_daily_quota_overrides SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL",
				[now, me.id, overrideId],
			);
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						me.id,
						"user_daily_quota_override_revoked",
						ip,
						userAgent,
						JSON.stringify({ overrideId }),
						now,
					],
				);
			} catch {
			}
			return redirect("/admin/quotas");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (message.includes("no such table") || message.includes("no such column")) {
				return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
			}
			return json<ActionData>({ formError: "撤销失败，请稍后重试" }, { status: 500 });
		}
	}

	return json<ActionData>({ formError: "未知操作" }, { status: 400 });
}

export default function AdminQuotasPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";

	const overrideMap = useMemo(() => {
		const map = new Map<number, ActiveOverrideRow[]>();
		for (const o of data.activeOverrides) {
			const list = map.get(o.userId) || [];
			list.push(o);
			map.set(o.userId, list);
		}
		return map;
	}, [data.activeOverrides]);

	return (
		<div className="mx-auto max-w-5xl px-4 py-6">
			<div className="mb-4 flex items-center justify-between">
				<h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">限额管理</h1>
				<Link to="/posts" className="text-sm text-gray-600 hover:underline dark:text-gray-300">
					返回论坛
				</Link>
			</div>

			<div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
				<h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">临时调整普通用户当日限额</h2>
				<Form method="post" className="grid grid-cols-1 gap-3 md:grid-cols-6">
					<input type="hidden" name="intent" value="setOverride" />
					<label className="md:col-span-1">
						<div className="mb-1 text-xs text-gray-600 dark:text-gray-300">用户ID</div>
						<input
							name="userId"
							required
							className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
						/>
					</label>
					<label className="md:col-span-1">
						<div className="mb-1 text-xs text-gray-600 dark:text-gray-300">发帖上限</div>
						<input
							name="postLimit"
							required
							inputMode="numeric"
							className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
						/>
					</label>
					<label className="md:col-span-1">
						<div className="mb-1 text-xs text-gray-600 dark:text-gray-300">评论上限（可选）</div>
						<input
							name="commentLimit"
							inputMode="numeric"
							className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
						/>
					</label>
					<label className="md:col-span-1">
						<div className="mb-1 text-xs text-gray-600 dark:text-gray-300">有效期</div>
						<select
							name="period"
							defaultValue="today"
							className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
						>
							<option value="today">仅今天</option>
							<option value="range">指定时间段（北京时间）</option>
						</select>
					</label>
					<label className="md:col-span-1">
						<div className="mb-1 text-xs text-gray-600 dark:text-gray-300">开始时间</div>
						<input
							name="startsAt"
							type="datetime-local"
							className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
						/>
					</label>
					<label className="md:col-span-1">
						<div className="mb-1 text-xs text-gray-600 dark:text-gray-300">结束时间</div>
						<input
							name="endsAt"
							type="datetime-local"
							className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
						/>
					</label>
					<label className="md:col-span-6">
						<div className="mb-1 text-xs text-gray-600 dark:text-gray-300">原因（可选）</div>
						<input
							name="reason"
							className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950"
						/>
					</label>
					<div className="md:col-span-6 flex items-center justify-between">
						{actionData?.formError ? (
							<p className="text-sm text-red-600">{actionData.formError}</p>
						) : (
							<span className="text-xs text-gray-600 dark:text-gray-300">默认：普通用户 10 帖 / 20 评；管理员/超管不限</span>
						)}
						<button
							type="submit"
							disabled={isSubmitting}
							className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
						>
							{isSubmitting ? "保存中..." : "保存"}
						</button>
					</div>
				</Form>
			</div>

			<div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
				<h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">今日用量（北京时间）</h2>
				<div className="overflow-x-auto">
					<table className="min-w-full text-left text-sm">
						<thead className="text-xs text-gray-600 dark:text-gray-300">
							<tr>
								<th className="py-2 pr-3">用户</th>
								<th className="py-2 pr-3">角色</th>
								<th className="py-2 pr-3">今日发帖</th>
								<th className="py-2 pr-3">今日评论</th>
								<th className="py-2 pr-3">临时标记</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-200 dark:divide-gray-800">
							{data.users.map((u) => {
								const overrides = overrideMap.get(u.id) || [];
								const isSpecial = overrides.length > 0;
								return (
									<tr key={u.id} className="align-top">
										<td className="py-2 pr-3">
											<div className="font-medium text-gray-900 dark:text-gray-100">
												{u.displayName}（{u.id}）
											</div>
											<div className="text-xs text-gray-600 dark:text-gray-300">{u.email}</div>
											{u.isBanned ? (
												<div className="mt-1 inline-flex rounded bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-200">
													已封禁
												</div>
											) : null}
										</td>
										<td className="py-2 pr-3 text-gray-700 dark:text-gray-200">{u.role}</td>
										<td className="py-2 pr-3 text-gray-700 dark:text-gray-200">{u.postCount}</td>
										<td className="py-2 pr-3 text-gray-700 dark:text-gray-200">{u.commentCount}</td>
										<td className="py-2 pr-3">
											{isSpecial ? (
												<div className="space-y-2">
													{overrides.map((o) => (
														<div key={o.id} className="rounded border border-yellow-200 bg-yellow-50 p-2 text-xs text-yellow-800 dark:border-yellow-900/40 dark:bg-yellow-900/20 dark:text-yellow-200">
															<div>临时限额：发帖 {typeof o.postLimit === "number" ? o.postLimit : "默认"}；评论 {typeof o.commentLimit === "number" ? o.commentLimit : "默认"}</div>
															<div>有效期：{new Date(o.startsAtMs).toLocaleString()} - {new Date(o.endsAtMs).toLocaleString()}</div>
															{o.reason ? <div>原因：{o.reason}</div> : null}
															<Form method="post" className="mt-1">
															<input type="hidden" name="intent" value="revokeOverride" />
															<input type="hidden" name="overrideId" value={o.id} />
															<button type="submit" disabled={isSubmitting} className="text-xs text-red-700 hover:underline disabled:opacity-70 dark:text-red-200">
																撤销
															</button>
														</Form>
														</div>
													))}
												</div>
											) : (
												<span className="text-xs text-gray-500 dark:text-gray-400">-</span>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</div>

			<div className="mt-6 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
				<h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">预警与审计（最近 80 条）</h2>
				<div className="overflow-x-auto">
					<table className="min-w-full text-left text-sm">
						<thead className="text-xs text-gray-600 dark:text-gray-300">
							<tr>
								<th className="py-2 pr-3">时间</th>
								<th className="py-2 pr-3">事件</th>
								<th className="py-2 pr-3">操作者</th>
								<th className="py-2 pr-3">数据</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-200 dark:divide-gray-800">
							{data.auditLogs.map((l) => (
								<tr key={l.id} className="align-top">
									<td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-300">
										{new Date(l.createdAt).toLocaleString()}
									</td>
									<td className="py-2 pr-3 text-gray-700 dark:text-gray-200">{l.eventType}</td>
									<td className="py-2 pr-3 text-gray-700 dark:text-gray-200">{l.userId}</td>
									<td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-300">
										<pre className="whitespace-pre-wrap break-words">{JSON.stringify(l.metadata, null, 2)}</pre>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}
