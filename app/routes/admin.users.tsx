import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import {
	assertAdmin,
	assertNotBanned,
	getClientIp,
	getRegistrationPaused,
	requireUser,
	sendEmail,
	type UserRole,
} from "~/lib/auth.server";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";

type UserListItem = {
	id: number;
	email: string;
	displayName: string;
	createdAt: number;
	role: string;
	isBanned: number;
	bannedAt: number | null;
	mustChangePassword: number;
	tempPasswordExpiresAt: number | null;
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

function normalizeRole(value: FormDataEntryValue | null): UserRole | null {
	const raw = typeof value === "string" ? value : "";
	if (raw === "superadmin" || raw === "admin" || raw === "user") {
		return raw;
	}
	return null;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	assertAdmin(me);

	const db = getDBFromContext(context);
	const users = await queryAll<UserListItem>(
		db,
		"SELECT id as id, email as email, display_name as displayName, created_at as createdAt, role as role, is_banned as isBanned, banned_at as bannedAt, must_change_password as mustChangePassword, temp_password_expires_at as tempPasswordExpiresAt FROM users ORDER BY created_at DESC LIMIT 200",
	);
	const registrationPaused = await getRegistrationPaused(context);
	return json({ me, users, registrationPaused });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	assertAdmin(me);

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "");
	if (intent === "setRegistrationPaused") {
		if (me.role !== "superadmin") {
			return json<ActionData>({ formError: "只有超级管理员可以修改注册状态" }, { status: 403 });
		}
		const pausedRaw = String(formData.get("paused") || "");
		const paused = pausedRaw === "1";
		const now = Date.now();
		const db = getDBFromContext(context);
		const ip = getClientIp(request);
		const userAgent = request.headers.get("User-Agent");
		try {
			await execute(
				db,
				"INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
				["registration_paused", paused ? "true" : "false", now],
			);
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					me.id,
					"registration_paused_set",
					ip,
					userAgent,
					JSON.stringify({ paused }),
					now,
				],
			);
			return redirect("/admin/users");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (message.includes("no such table")) {
				return json<ActionData>({ formError: "数据库未初始化：缺少必要的数据表" }, { status: 500 });
			}
			if (message.includes("no such column")) {
				return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
			}
			return json<ActionData>({ formError: "更新注册状态失败，请稍后重试" }, { status: 500 });
		}
	}

	const targetUserId = parseId(formData.get("userId"));
	if (!targetUserId) {
		return json<ActionData>({ formError: "无效的用户ID" }, { status: 400 });
	}
	if (targetUserId === me.id) {
		return json<ActionData>({ formError: "不能对自己执行该操作" }, { status: 400 });
	}

	const db = getDBFromContext(context);
	const target = await queryOne<{ id: number; role: string; isBanned: number }>(
		db,
		"SELECT id as id, role as role, is_banned as isBanned FROM users WHERE id = ?",
		[targetUserId],
	);
	if (!target) {
		return json<ActionData>({ formError: "用户不存在" }, { status: 404 });
	}
	if (target.role === "superadmin" && me.role !== "superadmin") {
		return json<ActionData>({ formError: "无权操作超级管理员" }, { status: 403 });
	}

	if (intent === "setRole") {
		if (me.role !== "superadmin") {
			return json<ActionData>({ formError: "只有超级管理员可以修改角色" }, { status: 403 });
		}
		if (target.role === "superadmin") {
			return json<ActionData>({ formError: "不能修改超级管理员角色" }, { status: 400 });
		}
		const nextRole = normalizeRole(formData.get("role"));
		if (!nextRole) {
			return json<ActionData>({ formError: "无效的角色" }, { status: 400 });
		}
		if (nextRole === "superadmin") {
			return json<ActionData>({ formError: "不能通过后台设置超级管理员" }, { status: 400 });
		}
		await execute(db, "UPDATE users SET role = ? WHERE id = ?", [nextRole, targetUserId]);
		return redirect("/admin/users");
	}

	if (intent === "toggleBan") {
		const willBan = !Boolean(target.isBanned);
		await execute(db, "UPDATE users SET is_banned = ?, banned_at = ? WHERE id = ?", [
			willBan ? 1 : 0,
			willBan ? Date.now() : null,
			targetUserId,
		]);
		return redirect("/admin/users");
	}

	if (intent === "resetPassword") {
		if (target.role === "superadmin") {
			return json<ActionData>({ formError: "不能重置超级管理员密码" }, { status: 400 });
		}
		if (me.role === "admin" && target.role !== "user") {
			return json<ActionData>({ formError: "管理员只能重置普通用户密码" }, { status: 403 });
		}
		if (target.role === "admin" && me.role !== "superadmin") {
			return json<ActionData>({ formError: "只有超级管理员可以重置管理员密码" }, { status: 403 });
		}

		const now = Date.now();
		const tempPassword = "123456";
		const expiresAt = now + 15 * 60 * 1000;
		const ip = getClientIp(request);
		const userAgent = request.headers.get("User-Agent");
		let emailTo: string | null = null;

		try {
			const targetEmail = await queryOne<{ email: string }>(
				db,
				"SELECT email as email FROM users WHERE id = ?",
				[targetUserId],
			);
			if (!targetEmail) {
				return json<ActionData>({ formError: "用户不存在" }, { status: 404 });
			}
			emailTo = targetEmail.email;

			const saltBytes = new Uint8Array(16);
			crypto.getRandomValues(saltBytes);
			const salt = Array.from(saltBytes)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			const encoder = new TextEncoder();
			const hashBuffer = await crypto.subtle.digest(
				"SHA-256",
				encoder.encode(`${salt}:${tempPassword}`),
			);
			const passwordHash = Array.from(new Uint8Array(hashBuffer))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");

			await execute(
				db,
				"UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 1, temp_password_expires_at = ? WHERE id = ?",
				[passwordHash, salt, expiresAt, targetUserId],
			);
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					targetUserId,
					"admin_pwd_reset",
					ip,
					userAgent,
					JSON.stringify({ operatorUserId: me.id, tempPasswordExpiresAt: expiresAt }),
					now,
				],
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						targetUserId,
						"admin_pwd_reset_failed",
						ip,
						userAgent,
						JSON.stringify({ operatorUserId: me.id, message }),
						Date.now(),
					],
				);
			} catch {
			}
			if (message.includes("no such table")) {
				return json<ActionData>({ formError: "数据库未初始化：缺少必要的数据表" }, { status: 500 });
			}
			if (message.includes("no such column")) {
				return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
			}
			return json<ActionData>({ formError: "重置失败，请稍后重试" }, { status: 500 });
		}

		if (emailTo) {
			const text =
				`你的账号密码已被管理员重置为临时密码。\n\n` +
				`临时密码：${tempPassword}\n` +
				`有效期：15 分钟\n\n` +
				`安全提示：请尽快使用临时密码登录，并立即修改为新密码（至少6位，包含字母和数字）。\n` +
				`操作时间：${new Date(now).toLocaleString()}`;
			try {
				await sendEmail(context, {
					to: emailTo,
					subject: "密码已重置（临时密码）",
					text,
				});
				try {
					await execute(
						db,
						"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						[
							targetUserId,
							"admin_pwd_reset_email_sent",
							ip,
							userAgent,
							JSON.stringify({ operatorUserId: me.id, to: emailTo }),
							Date.now(),
						],
					);
				} catch {
					return redirect("/admin/users");
				}
				return redirect("/admin/users");
			} catch (error) {
				try {
					await execute(
						db,
						"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						[
							targetUserId,
							"admin_pwd_reset_email_failed",
							ip,
							userAgent,
							JSON.stringify({ operatorUserId: me.id, message: error instanceof Error ? error.message : "" }),
							Date.now(),
						],
					);
				} catch {
					return redirect("/admin/users");
				}
				return redirect("/admin/users");
			}
		}

		return redirect("/admin/users");
	}

	return json<ActionData>({ formError: "未知操作" }, { status: 400 });
}

export default function AdminUsersPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const [query, setQuery] = useState("");
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) {
			return data.users;
		}
		return data.users.filter((u) => {
			const id = String(u.id);
			const email = String(u.email || "").toLowerCase();
			const name = String(u.displayName || "").toLowerCase();
			return id.includes(q) || email.includes(q) || name.includes(q);
		});
	}, [data.users, query]);

	function formatRemaining(expiresAt: number | null, mustChangePassword: number) {
		if (!mustChangePassword || !expiresAt) {
			return "-";
		}
		const diff = expiresAt - now;
		if (diff <= 0) {
			return "已过期";
		}
		const totalSeconds = Math.floor(diff / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}分${seconds.toString().padStart(2, "0")}秒`;
	}

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-5xl flex-col gap-6">
				<header className="flex items-center justify-between">
					<div>
						<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">用户管理</h1>
					</div>
					<Link
						to="/posts"
						className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
					>
						返回论坛
					</Link>
				</header>

				{actionData?.formError ? (
					<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						{actionData.formError}
					</div>
				) : null}

				<div className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div className="flex flex-col gap-1">
							<div className="text-sm font-medium text-gray-900 dark:text-gray-100">注册状态</div>
							<div className="flex flex-wrap items-center gap-2 text-sm">
								{data.registrationPaused ? (
									<span className="rounded bg-red-100 px-2 py-1 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-200">
										已暂停注册
									</span>
								) : (
									<span className="rounded bg-green-100 px-2 py-1 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-200">
										允许注册
									</span>
								)}
								<span className="text-xs text-gray-500 dark:text-gray-400">在暂停期间，新用户无法注册</span>
							</div>
						</div>
						{data.me.role === "superadmin" ? (
							<Form method="post" className="flex items-center gap-2">
								<input type="hidden" name="intent" value="setRegistrationPaused" />
								<input type="hidden" name="paused" value={data.registrationPaused ? "0" : "1"} />
								<button
									type="submit"
									className={
										data.registrationPaused
											? "rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700"
											: "rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
									}
								>
									{data.registrationPaused ? "恢复注册" : "暂停注册"}
								</button>
							</Form>
						) : (
							<span className="text-xs text-gray-500 dark:text-gray-400">只有超级管理员可修改</span>
						)}
					</div>
				</div>

				<div className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
					<label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
						搜索用户
					</label>
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="按 ID / 邮箱 / 昵称搜索"
						className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
					/>
				</div>

				<div className="overflow-hidden rounded-xl bg-white shadow dark:bg-gray-800">
					<table className="w-full table-auto text-left text-sm">
						<thead className="bg-gray-100 text-xs text-gray-600 dark:bg-gray-900/30 dark:text-gray-300">
							<tr>
								<th className="px-4 py-3">ID</th>
								<th className="px-4 py-3">邮箱</th>
								<th className="px-4 py-3">昵称</th>
								<th className="px-4 py-3">角色</th>
								<th className="px-4 py-3">状态</th>
								<th className="px-4 py-3">临时密码剩余</th>
								<th className="px-4 py-3">注册时间</th>
								<th className="px-4 py-3">操作</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-200 dark:divide-gray-700">
							{filtered.map((u) => {
								const banned = Boolean(u.isBanned);
								const isSuperadmin = u.role === "superadmin";
								const isSelf = u.id === data.me.id;
								const canManageRole = data.me.role === "superadmin" && !isSuperadmin && !isSelf;
								const canToggleBan = !isSelf && !isSuperadmin;
								const canReset =
									!isSelf &&
									!isSuperadmin &&
									(data.me.role === "superadmin" || u.role === "user");
								return (
									<tr key={u.id} className="text-gray-900 dark:text-gray-100">
										<td className="px-4 py-3">{u.id}</td>
										<td className="px-4 py-3 break-all text-gray-700 dark:text-gray-200">{u.email}</td>
										<td className="px-4 py-3">{u.displayName}</td>
										<td className="px-4 py-3">
											{canManageRole ? (
												<Form method="post" className="flex items-center gap-2">
													<input type="hidden" name="intent" value="setRole" />
													<input type="hidden" name="userId" value={u.id} />
													<select
														name="role"
														defaultValue={u.role}
														className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
													>
														<option value="user">user</option>
														<option value="admin">admin</option>
													</select>
													<button
														type="submit"
														className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
													>
														保存
													</button>
												</Form>
											) : (
													<span className="text-gray-700 dark:text-gray-200">{u.role}</span>
												)}
											</td>
											<td className="px-4 py-3">
												{banned ? (
													<span className="rounded bg-red-100 px-2 py-1 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-200">封禁</span>
												) : (
													<span className="rounded bg-green-100 px-2 py-1 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-200">正常</span>
												)}
											</td>
											<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
												{formatRemaining(u.tempPasswordExpiresAt, u.mustChangePassword)}
											</td>
											<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
												{new Date(u.createdAt).toLocaleString()}
											</td>
											<td className="px-4 py-3">
												<div className="flex flex-wrap items-center gap-2">
													{canToggleBan ? (
														<Form method="post">
															<input type="hidden" name="intent" value="toggleBan" />
															<input type="hidden" name="userId" value={u.id} />
															<button
																type="submit"
																className={
																	banned
																		? "rounded bg-gray-800 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
																		: "rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
																}
															>
																{banned ? "解封" : "封禁"}
															</button>
													</Form>
													) : null}
													{canReset ? (
														<Form
															method="post"
															onSubmit={(e) => {
																const ok = window.confirm(
																	`确认将该用户密码重置为临时密码 123456 吗？\n\n用户：${u.email}\n角色：${u.role}\n有效期：15分钟`,
																);
																if (!ok) {
																	e.preventDefault();
																}
															}}
														>
															<input type="hidden" name="intent" value="resetPassword" />
															<input type="hidden" name="userId" value={u.id} />
															<button
																type="submit"
																className="rounded bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
															>
																重置密码
															</button>
														</Form>
													) : null}
													{!canToggleBan && !canReset ? (
														<span className="text-xs text-gray-500 dark:text-gray-400">不可操作</span>
													) : null}
												</div>
											</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}
