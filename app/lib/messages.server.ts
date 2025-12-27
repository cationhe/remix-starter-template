import type { AppLoadContext } from "@remix-run/cloudflare";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";
import type { AuthUser, UserRole } from "~/lib/auth.server";

export type MessageListItem = {
	id: number;
	senderId: number;
	senderName: string;
	senderRole: UserRole;
	recipientId: number;
	recipientName: string;
	recipientRole: UserRole;
	content: string;
	createdAt: number;
	isPinned: number;
	pinnedAt: number | null;
	isImportant: number;
	readAt: number | null;
};

export type RecipientListItem = {
	id: number;
	displayName: string;
	role: UserRole;
};

export function canSendMessage(senderRole: UserRole, recipientRole: UserRole) {
	if (senderRole === "superadmin" || senderRole === "topadmin") {
		return recipientRole === "admin" || recipientRole === "user";
	}
	if (senderRole === "admin") {
		return recipientRole === "superadmin" || recipientRole === "topadmin" || recipientRole === "user";
	}
	return recipientRole === "superadmin" || recipientRole === "topadmin" || recipientRole === "admin";
}

export function getAllowedRecipientRoles(senderRole: UserRole): UserRole[] {
	if (senderRole === "superadmin" || senderRole === "topadmin") return ["admin", "user"];
	if (senderRole === "admin") return ["superadmin", "topadmin", "user"];
	return ["superadmin", "topadmin", "admin"];
}

export async function listRecipientsForUser(context: AppLoadContext, me: AuthUser, limit = 200) {
	const roles = getAllowedRecipientRoles(me.role);
	const db = getDBFromContext(context);
	const placeholders = roles.map(() => "?").join(",");
	const rows = await queryAll<RecipientListItem>(
		db,
		`SELECT id as id, display_name as displayName, role as role
		 FROM users
		 WHERE deleted_at IS NULL
		   AND id != ?
		   AND role IN (${placeholders})
		 ORDER BY created_at DESC
		 LIMIT ?`,
		[me.id, ...roles, limit],
	);
	return rows.map((r) => ({ ...r, role: r.role as UserRole }));
}

export async function countUnreadMessages(context: AppLoadContext, userId: number) {
	const db = getDBFromContext(context);
	const row = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM messages WHERE recipient_id = ? AND read_at IS NULL",
		[userId],
	);
	return Number(row?.count ?? 0);
}

export async function countMessagesForUser(context: AppLoadContext, userId: number) {
	const db = getDBFromContext(context);
	const row = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM messages WHERE sender_id = ? OR recipient_id = ?",
		[userId, userId],
	);
	return Number(row?.count ?? 0);
}

export async function listMessagesForUser(context: AppLoadContext, userId: number, page: number, pageSize: number) {
	const db = getDBFromContext(context);
	const offset = (page - 1) * pageSize;
	let rows: MessageListItem[] = [];
	try {
		rows = await queryAll<MessageListItem>(
			db,
			`SELECT
			  m.id as id,
			  m.sender_id as senderId,
			  s.display_name as senderName,
			  s.role as senderRole,
			  m.recipient_id as recipientId,
			  r.display_name as recipientName,
			  r.role as recipientRole,
			  m.content as content,
			  m.created_at as createdAt,
			  m.is_pinned as isPinned,
			  m.pinned_at as pinnedAt,
			  m.is_important as isImportant,
			  m.read_at as readAt
			FROM messages m
			JOIN users s ON m.sender_id = s.id
			JOIN users r ON m.recipient_id = r.id
			WHERE m.sender_id = ? OR m.recipient_id = ?
			ORDER BY m.is_pinned DESC, m.pinned_at DESC, m.created_at DESC
			LIMIT ? OFFSET ?`,
			[userId, userId, pageSize, offset],
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such column") && (message.includes("is_pinned") || message.includes("is_important"))) {
			const fallback = await queryAll<Omit<MessageListItem, "isPinned" | "pinnedAt" | "isImportant">>(
				db,
				`SELECT
				  m.id as id,
				  m.sender_id as senderId,
				  s.display_name as senderName,
				  s.role as senderRole,
				  m.recipient_id as recipientId,
				  r.display_name as recipientName,
				  r.role as recipientRole,
				  m.content as content,
				  m.created_at as createdAt,
				  m.read_at as readAt
				FROM messages m
				JOIN users s ON m.sender_id = s.id
				JOIN users r ON m.recipient_id = r.id
				WHERE m.sender_id = ? OR m.recipient_id = ?
				ORDER BY m.created_at DESC
				LIMIT ? OFFSET ?`,
				[userId, userId, pageSize, offset],
			);
			rows = fallback.map((m) => ({ ...m, isPinned: 0, pinnedAt: null, isImportant: 0 }));
		} else {
			throw error;
		}
	}
	return rows.map((m) => ({
		...m,
		senderRole: m.senderRole as UserRole,
		recipientRole: m.recipientRole as UserRole,
	}));
}

export async function findRecipientById(context: AppLoadContext, userId: number) {
	const db = getDBFromContext(context);
	const row = await queryOne<{ id: number; role: string; displayName: string; deletedAt: number | null }>(
		db,
		"SELECT id as id, role as role, display_name as displayName, deleted_at as deletedAt FROM users WHERE id = ?",
		[userId],
	);
	if (!row || row.deletedAt) return null;
	const role = row.role as UserRole;
	if (role !== "topadmin" && role !== "superadmin" && role !== "admin" && role !== "user") return null;
	return { id: row.id, role, displayName: row.displayName };
}

export async function sendMessage(
	context: AppLoadContext,
	args: { sender: AuthUser; recipientId: number; content: string; isPinned?: boolean; isImportant?: boolean },
) {
	const recipient = await findRecipientById(context, args.recipientId);
	if (!recipient) {
		return { ok: false as const, error: "收件人不存在" };
	}
	if (recipient.id === args.sender.id) {
		return { ok: false as const, error: "不能给自己发消息" };
	}
	if (!canSendMessage(args.sender.role, recipient.role)) {
		return { ok: false as const, error: "无权向该用户发送消息" };
	}
	const trimmed = args.content.trim();
	if (!trimmed) {
		return { ok: false as const, error: "消息内容不能为空" };
	}
	if (trimmed.length > 2000) {
		return { ok: false as const, error: "消息内容过长（最多 2000 字）" };
	}

	const db = getDBFromContext(context);
	const now = Date.now();
	const isPinned = args.isPinned ? 1 : 0;
	const pinnedAt = isPinned ? now : null;
	const isImportant = args.isImportant ? 1 : 0;
	try {
		await execute(
			db,
			"INSERT INTO messages (sender_id, recipient_id, content, created_at, read_at, is_pinned, pinned_at, is_important) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
			[args.sender.id, recipient.id, trimmed, now, isPinned, pinnedAt, isImportant],
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such column") && (message.includes("is_pinned") || message.includes("is_important"))) {
			await execute(
				db,
				"INSERT INTO messages (sender_id, recipient_id, content, created_at, read_at) VALUES (?, ?, ?, ?, NULL)",
				[args.sender.id, recipient.id, trimmed, now],
			);
		} else {
			throw error;
		}
	}
	return { ok: true as const };
}

export async function markMessageAsRead(context: AppLoadContext, args: { userId: number; messageId: number }) {
	const db = getDBFromContext(context);
	const now = Date.now();
	const result = await execute(
		db,
		"UPDATE messages SET read_at = ? WHERE id = ? AND recipient_id = ? AND read_at IS NULL",
		[now, args.messageId, args.userId],
	);
	return { ok: true as const, changed: Number(result.meta?.changes ?? 0) };
}

export async function deleteMessagesForUser(context: AppLoadContext, args: { userId: number; messageIds: number[] }) {
	const ids = args.messageIds
		.filter((n) => Number.isFinite(n) && n > 0)
		.map((n) => Math.floor(n));
	const uniqueIds = Array.from(new Set(ids));
	if (uniqueIds.length === 0) {
		return { ok: false as const, error: "未选择要删除的消息" };
	}
	if (uniqueIds.length > 500) {
		return { ok: false as const, error: "一次最多删除 500 条消息" };
	}

	const db = getDBFromContext(context);
	const placeholders = uniqueIds.map(() => "?").join(",");
	const owned = await queryOne<{ count: number | string }>(
		db,
		`SELECT COUNT(1) as count FROM messages WHERE id IN (${placeholders}) AND (sender_id = ? OR recipient_id = ?)`,
		[...uniqueIds, args.userId, args.userId],
	);
	const ownedCount = Number(owned?.count ?? 0);
	if (ownedCount !== uniqueIds.length) {
		return { ok: false as const, error: "包含不存在或无权删除的消息" };
	}

	const result = await execute(
		db,
		`DELETE FROM messages WHERE id IN (${placeholders}) AND (sender_id = ? OR recipient_id = ?)`,
		[...uniqueIds, args.userId, args.userId],
	);
	return { ok: true as const, deletedCount: Number(result.meta?.changes ?? 0) };
}
