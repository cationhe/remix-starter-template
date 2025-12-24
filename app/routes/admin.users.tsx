import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import {
	assertAdmin,
	assertNotBanned,
	getClientIp,
	getRegistrationPaused,
	requireUser,
	verifyLogin,
	sendEmail,
	type UserRole,
} from "~/lib/auth.server";
import {
	removeAllAttachmentUploadsForUploader,
	removeAllAttachmentsForPost,
	removeAllAttachmentsForUploader,
	removeAllCommentAttachmentUploadsForComments,
	removeAllCommentAttachmentUploadsForUploader,
	removeAllCommentAttachmentsForComments,
	removeAllCommentAttachmentsForPost,
	removeAllCommentAttachmentsForUploader,
} from "~/lib/attachments.server";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";

type UserListItem = {
	id: number;
	email: string;
	displayName: string;
	createdAt: number;
	role: string;
	isBanned: number;
	bannedAt: number | null;
	deletedAt: number | null;
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
	if (raw === "topadmin" || raw === "superadmin" || raw === "admin" || raw === "user") {
		return raw;
	}
	return null;
}

function normalizeDeleteMode(value: FormDataEntryValue | null) {
	const raw = typeof value === "string" ? value : "";
	return raw === "hard" ? "hard" : "soft";
}

function getPasswordValue(value: FormDataEntryValue | null) {
	return typeof value === "string" ? value : "";
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	assertAdmin(me);

	const db = getDBFromContext(context);
	const users = await queryAll<UserListItem>(
		db,
		"SELECT id as id, email as email, display_name as displayName, created_at as createdAt, role as role, is_banned as isBanned, banned_at as bannedAt, deleted_at as deletedAt, must_change_password as mustChangePassword, temp_password_expires_at as tempPasswordExpiresAt FROM users ORDER BY created_at DESC LIMIT 200",
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
		if (me.role !== "superadmin" && me.role !== "topadmin") {
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
	const target = await queryOne<{
		id: number;
		email: string;
		displayName: string;
		createdAt: number;
		role: string;
		isBanned: number;
		bannedAt: number | null;
		deletedAt: number | null;
	}>(
		db,
		"SELECT id as id, email as email, display_name as displayName, created_at as createdAt, role as role, is_banned as isBanned, banned_at as bannedAt, deleted_at as deletedAt FROM users WHERE id = ?",
		[targetUserId],
	);
	if (!target) {
		return json<ActionData>({ formError: "用户不存在" }, { status: 404 });
	}
	if (target.role === "topadmin" && me.role !== "topadmin") {
		return json<ActionData>({ formError: "无权操作 topadmin" }, { status: 403 });
	}
	if (target.role === "superadmin" && me.role !== "superadmin" && me.role !== "topadmin") {
		return json<ActionData>({ formError: "无权操作超级管理员" }, { status: 403 });
	}

	if (intent === "setRole") {
		const meIsTopadmin = me.role === "topadmin";
		const meIsSuperadmin = me.role === "superadmin" || meIsTopadmin;
		if (!meIsSuperadmin) {
			return json<ActionData>({ formError: "只有超级管理员可以修改角色" }, { status: 403 });
		}
		const nextRole = normalizeRole(formData.get("role"));
		if (!nextRole) {
			return json<ActionData>({ formError: "无效的角色" }, { status: 400 });
		}

		const password = getPasswordValue(formData.get("password"));
		if (!password) {
			return json<ActionData>({ formError: "需要二次验证密码" }, { status: 400 });
		}
		const verified = await verifyLogin(context, me.email, password);
		if (!verified || verified.id !== me.id) {
			return json<ActionData>({ formError: "二次验证失败" }, { status: 403 });
		}

		if (!meIsTopadmin) {
			if (target.role === "superadmin" || target.role === "topadmin") {
				return json<ActionData>({ formError: "不能修改超级管理员角色" }, { status: 400 });
			}
			if (nextRole === "superadmin" || nextRole === "topadmin") {
				return json<ActionData>({ formError: "不能通过后台设置超级管理员" }, { status: 400 });
			}
		}

		const prevRole = String(target.role || "user");
		const highRisk = prevRole === "superadmin" || nextRole === "superadmin";
		const now = Date.now();
		const ip = getClientIp(request);
		const userAgent = request.headers.get("User-Agent");

		try {
			await execute(db, "UPDATE users SET role = ? WHERE id = ?", [nextRole, targetUserId]);
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					me.id,
					"user_role_updated",
					ip,
					userAgent,
					JSON.stringify({
						operatorUserId: me.id,
						operatorRole: me.role,
						targetUserId,
						targetEmail: target.email,
						prevRole,
						nextRole,
						highRisk,
					}),
					now,
				],
			);
			if (highRisk) {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						me.id,
						"superadmin_role_change_warning",
						ip,
						userAgent,
						JSON.stringify({ operatorUserId: me.id, operatorRole: me.role, targetUserId, prevRole, nextRole }),
						now,
					],
				);
			}
			return redirect("/admin/users");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						me.id,
						"user_role_update_failed",
						ip,
						userAgent,
						JSON.stringify({ operatorUserId: me.id, targetUserId, prevRole, nextRole, message }),
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
			return json<ActionData>({ formError: "修改角色失败，请稍后重试" }, { status: 500 });
		}
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
		if (target.role === "admin" && me.role !== "superadmin" && me.role !== "topadmin") {
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

	if (intent === "restoreUser") {
		if (me.role !== "superadmin" && me.role !== "topadmin") {
			return json<ActionData>({ formError: "只有超级管理员可以恢复用户" }, { status: 403 });
		}
		if (!target.deletedAt) {
			return json<ActionData>({ formError: "该用户未被删除" }, { status: 400 });
		}
		const ttlMs = 7 * 24 * 60 * 60 * 1000;
		if (Date.now() - target.deletedAt > ttlMs) {
			return json<ActionData>({ formError: "已超过 7 天可恢复期限" }, { status: 400 });
		}
		const password = getPasswordValue(formData.get("password"));
		if (!password) {
			return json<ActionData>({ formError: "需要二次验证密码" }, { status: 400 });
		}
		const verified = await verifyLogin(context, me.email, password);
		if (!verified || verified.id !== me.id) {
			return json<ActionData>({ formError: "二次验证失败" }, { status: 403 });
		}
		const now = Date.now();
		const ip = getClientIp(request);
		const userAgent = request.headers.get("User-Agent");
		try {
			await execute(db, "UPDATE users SET deleted_at = NULL WHERE id = ?", [targetUserId]);
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					me.id,
					"superadmin_user_restored",
					ip,
					userAgent,
					JSON.stringify({ targetUserId, targetEmail: target.email }),
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
			return json<ActionData>({ formError: "恢复失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "deleteBannedUser") {
		if (me.role !== "superadmin" && me.role !== "topadmin") {
			return json<ActionData>({ formError: "只有超级管理员可以删除用户" }, { status: 403 });
		}
		if (!Boolean(target.isBanned)) {
			return json<ActionData>({ formError: "只能删除已封禁用户" }, { status: 400 });
		}
		if (target.deletedAt) {
			return json<ActionData>({ formError: "该用户已被删除" }, { status: 400 });
		}
		const password = getPasswordValue(formData.get("password"));
		if (!password) {
			return json<ActionData>({ formError: "需要二次验证密码" }, { status: 400 });
		}
		const verified = await verifyLogin(context, me.email, password);
		if (!verified || verified.id !== me.id) {
			return json<ActionData>({ formError: "二次验证失败" }, { status: 403 });
		}
		const mode = normalizeDeleteMode(formData.get("mode"));
		const now = Date.now();
		const ip = getClientIp(request);
		const userAgent = request.headers.get("User-Agent");

		try {
			const postCount = await queryOne<{ count: number | string }>(
				db,
				"SELECT COUNT(1) as count FROM posts WHERE author_id = ?",
				[targetUserId],
			);
			const commentCount = await queryOne<{ count: number | string }>(
				db,
				"SELECT COUNT(1) as count FROM comments WHERE author_id = ?",
				[targetUserId],
			);
			const likeCount = await queryOne<{ count: number | string }>(
				db,
				"SELECT COUNT(1) as count FROM post_likes WHERE user_id = ?",
				[targetUserId],
			);
			const attachmentCount = await queryOne<{ count: number | string }>(
				db,
				"SELECT COUNT(1) as count FROM attachments WHERE uploader_id = ?",
				[targetUserId],
			);
			const commentAttachmentCount = await queryOne<{ count: number | string }>(
				db,
				"SELECT COUNT(1) as count FROM comment_attachments WHERE uploader_id = ?",
				[targetUserId],
			);

			const posts = await queryAll<{ id: number }>(
				db,
				"SELECT id as id FROM posts WHERE author_id = ? ORDER BY created_at DESC LIMIT 200",
				[targetUserId],
			);
			const comments = await queryAll<{ id: number }>(
				db,
				"SELECT id as id FROM comments WHERE author_id = ? ORDER BY created_at DESC LIMIT 500",
				[targetUserId],
			);
			const attachmentKeys = await queryAll<{ r2Key: string }>(
				db,
				"SELECT r2_key as r2Key FROM attachments WHERE uploader_id = ? ORDER BY created_at DESC LIMIT 200",
				[targetUserId],
			);
			const commentAttachmentKeys = await queryAll<{ r2Key: string }>(
				db,
				"SELECT r2_key as r2Key FROM comment_attachments WHERE uploader_id = ? ORDER BY created_at DESC LIMIT 200",
				[targetUserId],
			);

			const backup = {
				target: {
					id: target.id,
					email: target.email,
					displayName: target.displayName,
					createdAt: target.createdAt,
					role: target.role,
					isBanned: target.isBanned,
					bannedAt: target.bannedAt,
					deletedAt: target.deletedAt,
				},
				operator: { id: me.id, email: me.email, role: me.role },
				counts: {
					posts: Number(postCount?.count ?? 0),
					comments: Number(commentCount?.count ?? 0),
					postLikes: Number(likeCount?.count ?? 0),
					attachments: Number(attachmentCount?.count ?? 0),
					commentAttachments: Number(commentAttachmentCount?.count ?? 0),
				},
				samples: {
					postIds: posts.map((p) => p.id),
					commentIds: comments.map((c) => c.id),
					attachmentKeys: attachmentKeys.map((a) => a.r2Key),
					commentAttachmentKeys: commentAttachmentKeys.map((a) => a.r2Key),
				},
				createdAt: now,
				mode,
			};

			await execute(
				db,
				"INSERT INTO user_deletion_backups (target_user_id, operator_user_id, mode, backup_json, created_at) VALUES (?, ?, ?, ?, ?)",
				[targetUserId, me.id, mode, JSON.stringify(backup), now],
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (message.includes("no such table") || message.includes("no such column")) {
				return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
			}
			return json<ActionData>({ formError: "备份失败，已取消删除" }, { status: 500 });
		}

		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					me.id,
					mode === "hard" ? "superadmin_user_hard_delete_started" : "superadmin_user_soft_delete_started",
					ip,
					userAgent,
					JSON.stringify({ targetUserId, targetEmail: target.email }),
					now,
				],
			);
		} catch {
		}

		if (mode === "soft") {
			try {
				await execute(db, "UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", [now, targetUserId]);
				try {
					await execute(
						db,
						"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						[
							me.id,
							"superadmin_user_soft_deleted",
							ip,
							userAgent,
							JSON.stringify({ targetUserId, targetEmail: target.email }),
							now,
						],
					);
				} catch {
				}
				return redirect("/admin/users");
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				if (message.includes("no such table")) {
					return json<ActionData>({ formError: "数据库未初始化：缺少必要的数据表" }, { status: 500 });
				}
				if (message.includes("no such column")) {
					return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
				}
				return json<ActionData>({ formError: "删除失败，请稍后重试" }, { status: 500 });
			}
		}

		try {
			const postRows = await queryAll<{ id: number }>(db, "SELECT id as id FROM posts WHERE author_id = ?", [
				targetUserId,
			]);
			const postIds = postRows.map((p) => p.id);
			for (const postId of postIds) {
				await removeAllAttachmentsForPost(context, postId);
				await removeAllCommentAttachmentsForPost(context, postId);
			}
			if (postIds.length > 0) {
				const placeholders = postIds.map(() => "?").join(",");
				await execute(db, `DELETE FROM post_likes WHERE post_id IN (${placeholders})`, postIds);
				await execute(db, `DELETE FROM comments WHERE post_id IN (${placeholders})`, postIds);
				await execute(db, `DELETE FROM posts WHERE id IN (${placeholders})`, postIds);
			}

			const commentRows = await queryAll<{ id: number }>(
				db,
				"SELECT id as id FROM comments WHERE author_id = ?",
				[targetUserId],
			);
			const commentIds = commentRows.map((c) => c.id);
			await removeAllCommentAttachmentUploadsForComments(context, commentIds);
			await removeAllCommentAttachmentsForComments(context, commentIds);
			await execute(db, "DELETE FROM comments WHERE author_id = ?", [targetUserId]);
			await execute(db, "DELETE FROM post_likes WHERE user_id = ?", [targetUserId]);
			await execute(db, "DELETE FROM password_resets WHERE user_id = ?", [targetUserId]);
			await removeAllAttachmentUploadsForUploader(context, targetUserId);
			await removeAllCommentAttachmentUploadsForUploader(context, targetUserId);
			await removeAllAttachmentsForUploader(context, targetUserId);
			await removeAllCommentAttachmentsForUploader(context, targetUserId);
			await execute(db, "DELETE FROM security_audit_logs WHERE user_id = ?", [targetUserId]);
			await execute(db, "DELETE FROM users WHERE id = ?", [targetUserId]);
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						me.id,
						"superadmin_user_hard_deleted",
						ip,
						userAgent,
						JSON.stringify({ targetUserId, targetEmail: target.email }),
						now,
					],
				);
			} catch {
			}
			return redirect("/admin/users");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						me.id,
						"superadmin_user_delete_failed",
						ip,
						userAgent,
						JSON.stringify({ targetUserId, targetEmail: target.email, message }),
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
			return json<ActionData>({ formError: "删除失败，请稍后重试" }, { status: 500 });
		}
	}

	return json<ActionData>({ formError: "未知操作" }, { status: 400 });
}

export default function AdminUsersPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const [query, setQuery] = useState("");
	const [filterMode, setFilterMode] = useState<"all" | "banned" | "deleted">("all");
	const [now, setNow] = useState(() => Date.now());
	const [dialogUser, setDialogUser] = useState<UserListItem | null>(null);
	const [dialogIntent, setDialogIntent] = useState<"deleteBannedUser" | "restoreUser" | "setRole">(
		"deleteBannedUser",
	);
	const [dialogNextRole, setDialogNextRole] = useState<UserRole>("user");
	const [verifyPassword, setVerifyPassword] = useState("");
	const [deleteMode, setDeleteMode] = useState<"soft" | "hard">("soft");
	const [dialogSubmitting, setDialogSubmitting] = useState(false);

	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);

	useEffect(() => {
		if (!dialogSubmitting) return;
		if (navigation.state !== "idle") return;
		if (actionData?.formError) {
			setDialogSubmitting(false);
			return;
		}
		setDialogUser(null);
		setVerifyPassword("");
		setDeleteMode("soft");
		setDialogNextRole("user");
		setDialogSubmitting(false);
	}, [actionData?.formError, dialogSubmitting, navigation.state]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return data.users
			.filter((u) => {
				if (filterMode === "banned") return Boolean(u.isBanned) && !u.deletedAt;
				if (filterMode === "deleted") return Boolean(u.deletedAt);
				return true;
			})
			.filter((u) => {
				if (!q) return true;
				const id = String(u.id);
				const email = String(u.email || "").toLowerCase();
				const name = String(u.displayName || "").toLowerCase();
				return id.includes(q) || email.includes(q) || name.includes(q);
			});
	}, [data.users, filterMode, query]);

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
					{data.me.role === "superadmin" || data.me.role === "topadmin" ? (
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
							<span className="text-xs text-gray-500 dark:text-gray-400">只有 superadmin/topadmin 可修改</span>
						)}
					</div>
				</div>

				<div className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
						<div className="flex-1">
							<label className="block text-sm font-medium text-gray-700 dark:text-gray-200">搜索用户</label>
							<input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="按 ID / 邮箱 / 昵称搜索"
								className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
							/>
						</div>
						<div className="min-w-[180px]">
							<label className="block text-sm font-medium text-gray-700 dark:text-gray-200">筛选</label>
							<select
								value={filterMode}
								onChange={(e) => setFilterMode(e.target.value as any)}
								className="mt-2 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
							>
								<option value="all">全部</option>
								<option value="banned">仅封禁</option>
								<option value="deleted">仅已删除</option>
							</select>
						</div>
					</div>
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
								const deleted = Boolean(u.deletedAt);
								const isTopadmin = u.role === "topadmin";
								const isSuperadmin = u.role === "superadmin" || isTopadmin;
								const meIsTopadmin = data.me.role === "topadmin";
								const meIsSuperadmin = data.me.role === "superadmin" || meIsTopadmin;
								const isSelf = u.id === data.me.id;
								const canManageRole = meIsTopadmin ? !isSelf : data.me.role === "superadmin" && !isSuperadmin && !isSelf;
								const canToggleBan = !isSelf && !isSuperadmin;
								const canReset =
									!isSelf &&
									!isSuperadmin &&
									(meIsSuperadmin || u.role === "user");
								const canDeleteBanned =
									meIsSuperadmin && banned && !deleted && !isSelf && !isSuperadmin;
								const canRestore =
									meIsSuperadmin && deleted && !isSelf && !isSuperadmin && now - (u.deletedAt ?? 0) <= 7 * 24 * 60 * 60 * 1000;
								return (
									<tr
										key={u.id}
										className={
											banned && !deleted
												? "bg-red-50 text-gray-900 dark:bg-red-900/10 dark:text-gray-100"
												: "text-gray-900 dark:text-gray-100"
										}
									>
										<td className="px-4 py-3">{u.id}</td>
										<td
											className={
												banned && !deleted
													? "px-4 py-3 break-all text-red-700 dark:text-red-200"
													: "px-4 py-3 break-all text-gray-700 dark:text-gray-200"
											}
										>
											{u.email}
										</td>
									<td className="px-4 py-3">{u.displayName}</td>
									<td className="px-4 py-3">
										<div className="flex items-center gap-2">
											<span className="text-gray-700 dark:text-gray-200">{u.role}</span>
											{canManageRole ? (
												<button
													type="button"
													onClick={() => {
														setDialogUser(u);
														setDialogIntent("setRole");
														setDialogNextRole(normalizeRole(u.role) ?? "user");
														setVerifyPassword("");
													}}
													className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
												>
													修改
												</button>
											) : null}
										</div>
										</td>
										<td className="px-4 py-3">
											{deleted ? (
												<span className="rounded bg-gray-200 px-2 py-1 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-100">已删除</span>
											) : banned ? (
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
													{canRestore ? (
														<button
															type="button"
															onClick={() => {
																setDialogUser(u);
																setDialogIntent("restoreUser");
																setVerifyPassword("");
															}}
															className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
														>
															恢复
														</button>
													) : null}
													{canDeleteBanned ? (
														<button
															type="button"
															onClick={() => {
																setDialogUser(u);
																setDialogIntent("deleteBannedUser");
																setVerifyPassword("");
																setDeleteMode("soft");
															}}
															className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
														>
															删除
														</button>
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

			{dialogUser ? (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
					<div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-lg dark:bg-gray-900">
						<div className="flex items-start justify-between gap-4">
							<div>
								<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
									{dialogIntent === "deleteBannedUser"
										? "删除用户"
										: dialogIntent === "restoreUser"
											? "恢复用户"
											: "修改角色"}
								</h2>
								<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
									用户：{dialogUser.email}（ID {dialogUser.id}）
								</p>
								</div>
								<button
									type="button"
									onClick={() => {
										if (dialogSubmitting) return;
										setDialogUser(null);
									}}
									disabled={dialogSubmitting}
									className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
								>
									关闭
								</button>
							</div>

						{dialogIntent === "deleteBannedUser" ? (
							<div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
								该操作为高危操作：删除后将影响该用户及其关联数据。
							</div>
						) : dialogIntent === "restoreUser" ? (
							<div className="mt-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-900/50 dark:bg-blue-900/20 dark:text-blue-200">
								仅支持删除后 7 天内恢复。
							</div>
						) : (
							<div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
								该操作需要二次验证密码，并会记录审计日志。
							</div>
						)}

							<Form
								method="post"
								onSubmit={(e) => {
									if (!verifyPassword.trim()) {
										e.preventDefault();
										return;
									}
									setDialogSubmitting(true);
								}}
								className="mt-4 flex flex-col gap-4"
							>
								<input type="hidden" name="intent" value={dialogIntent} />
								<input type="hidden" name="userId" value={dialogUser.id} />
								{dialogIntent === "setRole" ? (
									<>
										{dialogUser.role === "superadmin" || dialogNextRole === "superadmin" ? (
											<div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
												高危操作警告：对 superadmin 账户的等级调整会影响全站权限体系。
											</div>
										) : null}
										<div className="flex flex-col gap-2">
											<label
												htmlFor="dialog_role"
												className="text-sm font-medium text-gray-800 dark:text-gray-200"
											>
												目标角色
											</label>
											<select
												id="dialog_role"
												name="role"
												value={dialogNextRole}
												onChange={(e) => setDialogNextRole(e.target.value as UserRole)}
												className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
											>
												{data.me.role === "topadmin" ? (
													<>
														<option value="user">user</option>
														<option value="admin">admin</option>
														<option value="superadmin">superadmin</option>
														<option value="topadmin">topadmin</option>
													</>
												) : (
													<>
														<option value="user">user</option>
														<option value="admin">admin</option>
													</>
												)}
											</select>
										</div>
									</>
								) : null}
								{dialogIntent === "deleteBannedUser" ? (
									<div className="flex flex-col gap-2">
										<div className="text-sm font-medium text-gray-800 dark:text-gray-200">删除方式</div>
										<div className="flex flex-col gap-2 text-sm text-gray-700 dark:text-gray-200">
											<label className="flex items-center gap-2">
												<input
													type="radio"
													name="mode"
													value="soft"
													checked={deleteMode === "soft"}
													onChange={() => setDeleteMode("soft")}
												/>
												7天可恢复（软删除）
											</label>
											<label className="flex items-center gap-2">
												<input
													type="radio"
													name="mode"
													value="hard"
													checked={deleteMode === "hard"}
													onChange={() => setDeleteMode("hard")}
												/>
												立即永久删除（不可恢复）
											</label>
										</div>
									</div>
								) : null}

									<div className="flex flex-col gap-2">
										<label
											htmlFor="dialog_password"
											className="text-sm font-medium text-gray-800 dark:text-gray-200"
										>
											二次验证密码
										</label>
										<input
											type="password"
											id="dialog_password"
											name="password"
											value={verifyPassword}
											onChange={(e) => setVerifyPassword(e.target.value)}
											placeholder="请输入你的账号密码"
											className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
										/>
									</div>

								<div className="flex items-center justify-end gap-2">
									<button
										type="button"
										onClick={() => {
											if (dialogSubmitting) return;
											setDialogUser(null);
									}}
										disabled={dialogSubmitting}
										className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
									>
										取消
									</button>
									<button
										type="submit"
										disabled={dialogSubmitting && navigation.state !== "idle"}
										className={
											dialogIntent === "deleteBannedUser" ||
											(dialogIntent === "setRole" &&
												(dialogUser.role === "superadmin" || dialogNextRole === "superadmin"))
												? "rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
												: dialogIntent === "setRole"
													? "rounded bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700"
													: "rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
										}
									>
										{dialogSubmitting && navigation.state !== "idle"
											? "处理中..."
											: dialogIntent === "deleteBannedUser"
												? "确认执行"
												: dialogIntent === "restoreUser"
													? "确认恢复"
													: "确认修改"}
									</button>
								</div>
							</Form>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
