import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { assertAdmin, assertNotBanned, requireUser, type UserRole } from "~/lib/auth.server";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";

type UserListItem = {
	id: number;
	email: string;
	displayName: string;
	createdAt: number;
	role: string;
	isBanned: number;
	bannedAt: number | null;
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
		"SELECT id as id, email as email, display_name as displayName, created_at as createdAt, role as role, is_banned as isBanned, banned_at as bannedAt FROM users ORDER BY created_at DESC LIMIT 200",
	);
	return json({ me, users });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	assertAdmin(me);

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "");
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

	return json<ActionData>({ formError: "未知操作" }, { status: 400 });
}

export default function AdminUsersPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();

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

				<div className="overflow-hidden rounded-xl bg-white shadow dark:bg-gray-800">
					<table className="w-full table-auto text-left text-sm">
						<thead className="bg-gray-100 text-xs text-gray-600 dark:bg-gray-900/30 dark:text-gray-300">
							<tr>
								<th className="px-4 py-3">ID</th>
								<th className="px-4 py-3">邮箱</th>
								<th className="px-4 py-3">昵称</th>
								<th className="px-4 py-3">角色</th>
								<th className="px-4 py-3">状态</th>
								<th className="px-4 py-3">注册时间</th>
								<th className="px-4 py-3">操作</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-200 dark:divide-gray-700">
							{data.users.map((u) => {
								const banned = Boolean(u.isBanned);
								const isSuperadmin = u.role === "superadmin";
								const isSelf = u.id === data.me.id;
								const canManageRole = data.me.role === "superadmin" && !isSuperadmin && !isSelf;
								const canToggleBan = !isSelf && !isSuperadmin;
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
											{new Date(u.createdAt).toLocaleString()}
										</td>
										<td className="px-4 py-3">
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
											) : (
												<span className="text-xs text-gray-500 dark:text-gray-400">不可操作</span>
											)}
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
