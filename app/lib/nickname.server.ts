import type { AppLoadContext } from "@remix-run/cloudflare";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";

export type PendingNicknameRequest = {
	id: number;
	userId: number;
	currentDisplayName: string;
	desiredDisplayName: string;
	createdAt: number;
};

export type AdminNicknameRequestListItem = {
	id: number;
	userId: number;
	userEmail: string;
	userRole: string;
	currentDisplayName: string;
	desiredDisplayName: string;
	status: string;
	createdAt: number;
};

function normalizeDisplayName(input: string) {
	return String(input || "")
		.replace(/\u0000/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

const RESERVED_DISPLAY_NAMES = [
	"系统",
	"系统消息",
	"管理员",
	"超级管理员",
	"超管",
	"官方",
	"superadmin",
	"admin",
];

const SENSITIVE_WORDS = [
	"傻逼",
	"操你",
	"妈的",
	"fuck",
	"shit",
];

export function validateDisplayName(input: string) {
	const value = normalizeDisplayName(input);
	if (!value) {
		return { ok: false as const, error: "昵称不能为空" };
	}
	if (value.length > 20) {
		return { ok: false as const, error: "昵称过长（最多 20 字）" };
	}
	if (/[\u0000-\u001f\u007f]/.test(value)) {
		return { ok: false as const, error: "昵称包含非法字符" };
	}
	if (/[<>]/.test(value)) {
		return { ok: false as const, error: "昵称包含非法字符" };
	}
	const lower = value.toLowerCase();
	for (const reserved of RESERVED_DISPLAY_NAMES) {
		if (!reserved) continue;
		if (lower === reserved.toLowerCase()) {
			return { ok: false as const, error: "昵称不可用" };
		}
	}
	for (const w of SENSITIVE_WORDS) {
		if (!w) continue;
		if (lower.includes(w.toLowerCase())) {
			return { ok: false as const, error: "昵称包含敏感词" };
		}
	}
	return { ok: true as const, value };
}

export async function getDisplayNameChangedAt(context: AppLoadContext, userId: number) {
	const db = getDBFromContext(context);
	try {
		const row = await queryOne<{ changedAt: number | null }>(
			db,
			"SELECT display_name_changed_at as changedAt FROM users WHERE id = ? AND deleted_at IS NULL",
			[userId],
		);
		return row?.changedAt ?? null;
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such column")) {
			return null;
		}
		throw error;
	}
}

export async function getPendingNicknameRequestForUser(context: AppLoadContext, userId: number) {
	const db = getDBFromContext(context);
	try {
		const row = await queryOne<PendingNicknameRequest>(
			db,
			"SELECT id as id, user_id as userId, current_display_name as currentDisplayName, desired_display_name as desiredDisplayName, created_at as createdAt FROM nickname_change_requests WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1",
			[userId],
		);
		return row ?? null;
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such table") || message.includes("no such column")) {
			return null;
		}
		throw error;
	}
}

export async function tryUpdateDisplayNameOnce(args: {
	context: AppLoadContext;
	userId: number;
	nextDisplayName: string;
	now: number;
}) {
	const db = getDBFromContext(args.context);
	try {
		const result = await execute(
			db,
			"UPDATE users SET display_name = ?, display_name_changed_at = ? WHERE id = ? AND deleted_at IS NULL AND display_name_changed_at IS NULL",
			[args.nextDisplayName, args.now, args.userId],
		);
		const changed = Number((result as any)?.meta?.changes ?? 0);
		return { ok: true as const, changed };
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such column")) {
			return { ok: false as const, status: 500, error: "数据库未升级：请先应用最新迁移" };
		}
		throw error;
	}
}

export async function createNicknameChangeRequest(args: {
	context: AppLoadContext;
	userId: number;
	currentDisplayName: string;
	desiredDisplayName: string;
	now: number;
}) {
	const db = getDBFromContext(args.context);
	try {
		await execute(
			db,
			"INSERT INTO nickname_change_requests (user_id, current_display_name, desired_display_name, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
			[args.userId, args.currentDisplayName, args.desiredDisplayName, args.now],
		);
		return { ok: true as const };
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("UNIQUE") || message.includes("unique")) {
			return { ok: false as const, status: 400, error: "已有待审批申请，请勿重复提交" };
		}
		if (message.includes("no such table") || message.includes("no such column")) {
			return { ok: false as const, status: 500, error: "数据库未升级：请先应用最新迁移" };
		}
		throw error;
	}
}

export async function listSuperadminIds(context: AppLoadContext) {
	const db = getDBFromContext(context);
	try {
		const rows = await queryAll<{ id: number }>(
			db,
			"SELECT id as id FROM users WHERE role = 'superadmin' AND deleted_at IS NULL ORDER BY created_at ASC",
		);
		return rows.map((r) => r.id);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such column") || message.includes("no such table")) {
			return [];
		}
		throw error;
	}
}

export async function listPendingNicknameRequests(context: AppLoadContext, limit = 200) {
	const db = getDBFromContext(context);
	try {
		return await queryAll<AdminNicknameRequestListItem>(
			db,
			"SELECT r.id as id, r.user_id as userId, u.email as userEmail, u.role as userRole, r.current_display_name as currentDisplayName, r.desired_display_name as desiredDisplayName, r.status as status, r.created_at as createdAt FROM nickname_change_requests r JOIN users u ON r.user_id = u.id WHERE r.status = 'pending' ORDER BY r.created_at ASC, r.id ASC LIMIT ?",
			[limit],
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such table") || message.includes("no such column")) {
			return [];
		}
		throw error;
	}
}

export async function reviewNicknameChangeRequest(args: {
	context: AppLoadContext;
	requestId: number;
	approved: boolean;
	reviewedBy: number;
	reviewNote: string | null;
	now: number;
}) {
	const db = getDBFromContext(args.context);
	try {
		const row = await queryOne<{
			id: number;
			userId: number;
			desiredDisplayName: string;
			status: string;
		}>(
			db,
			"SELECT id as id, user_id as userId, desired_display_name as desiredDisplayName, status as status FROM nickname_change_requests WHERE id = ?",
			[args.requestId],
		);
		if (!row || row.status !== "pending") {
			return { ok: false as const, status: 400, error: "申请不存在或已处理" };
		}
		if (args.approved) {
			const results = await db.batch([
				db
					.prepare(
						"UPDATE nickname_change_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM users u WHERE u.id = nickname_change_requests.user_id AND u.deleted_at IS NULL)",
					)
					.bind(args.now, args.reviewedBy, args.reviewNote, args.requestId),
				db
					.prepare(
						"UPDATE users SET display_name = (SELECT desired_display_name FROM nickname_change_requests WHERE id = ? AND status = 'approved'), display_name_changed_at = COALESCE(display_name_changed_at, ?) WHERE id = (SELECT user_id FROM nickname_change_requests WHERE id = ? AND status = 'approved') AND deleted_at IS NULL",
					)
					.bind(args.requestId, args.now, args.requestId),
			]);
			const changed = Number((results[0] as any)?.meta?.changes ?? 0);
			if (changed !== 1) {
				return { ok: false as const, status: 400, error: "申请不存在、已处理或用户已删除" };
			}
			return { ok: true as const, userId: row.userId, desiredDisplayName: row.desiredDisplayName };
		}

		const results = await db.batch([
			db
				.prepare(
					"UPDATE nickname_change_requests SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM users u WHERE u.id = nickname_change_requests.user_id AND u.deleted_at IS NULL)",
				)
				.bind(args.now, args.reviewedBy, args.reviewNote, args.requestId),
		]);
		const changed = Number((results[0] as any)?.meta?.changes ?? 0);
		if (changed !== 1) {
			return { ok: false as const, status: 400, error: "申请不存在、已处理或用户已删除" };
		}
		return { ok: true as const, userId: row.userId, desiredDisplayName: row.desiredDisplayName };
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such table") || message.includes("no such column")) {
			return { ok: false as const, status: 500, error: "数据库未升级：请先应用最新迁移" };
		}
		if (message.includes("To execute a transaction")) {
			return { ok: false as const, status: 500, error: "数据库事务执行失败：请稍后重试" };
		}
		throw error;
	}
}
