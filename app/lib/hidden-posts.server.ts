import type { AppLoadContext, Session } from "@remix-run/cloudflare";
import { getDBFromContext, queryAll, queryOne, execute } from "~/lib/d1.server";
import type { AuthUser } from "~/lib/auth.server";
import { getSession, commitSession } from "~/lib/session.server";

function getEnv(context: AppLoadContext): Env {
	return (context as any).cloudflare.env as Env;
}

function getTokenPepper(context: AppLoadContext) {
	const env = getEnv(context) as any;
	const v = String(env?.HIDDEN_POST_TOKEN_PEPPER ?? "").trim();
	if (v) return v;
	return String(env?.SESSION_SECRET ?? "dev-only-session-secret-change-me").trim();
}

function toBase64Url(bytes: Uint8Array) {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	const base64 = btoa(binary);
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(input: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(hashBuffer);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function getAccessMap(session: Session): Record<string, number> {
	const raw = session.get("hiddenPostAccess");
	if (typeof raw !== "string") return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const obj = parsed as Record<string, unknown>;
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(obj)) {
			const n = typeof v === "number" ? v : Number(v);
			if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
		}
		return out;
	} catch {
		return {};
	}
}

function setAccessMap(session: Session, map: Record<string, number>) {
	session.set("hiddenPostAccess", JSON.stringify(map));
}

function hasSessionAccess(session: Session, postId: number) {
	const map = getAccessMap(session);
	return Number.isFinite(map[String(postId)]) && map[String(postId)] > 0;
}

function grantSessionAccess(session: Session, postId: number, now: number) {
	const map = getAccessMap(session);
	map[String(postId)] = now;
	setAccessMap(session, map);
}

async function isInvited(context: AppLoadContext, postId: number, userId: number) {
	const db = getDBFromContext(context);
	const row = await queryOne<{ invited: number }>(
		db,
		"SELECT 1 as invited FROM hidden_post_invites WHERE post_id = ? AND invited_user_id = ? AND revoked_at IS NULL LIMIT 1",
		[postId, userId],
	);
	return Boolean(row?.invited);
}

export type HiddenPostInviteItem = {
	postId: number;
	invitedUserId: number;
	invitedUserName: string;
	invitedBy: number;
	invitedByName: string;
	invitedAt: number;
	acceptedAt: number | null;
	revokedAt: number | null;
	revokedBy: number | null;
};

export async function isUserInvitedToHiddenPost(context: AppLoadContext, postId: number, userId: number) {
	return isInvited(context, postId, userId);
}

export async function listHiddenPostInvites(context: AppLoadContext, postId: number) {
	const db = getDBFromContext(context);
	const rows = await queryAll<HiddenPostInviteItem>(
		db,
		"SELECT i.post_id as postId, i.invited_user_id as invitedUserId, u.display_name as invitedUserName, i.invited_by as invitedBy, ib.display_name as invitedByName, i.invited_at as invitedAt, i.accepted_at as acceptedAt, i.revoked_at as revokedAt, i.revoked_by as revokedBy FROM hidden_post_invites i JOIN users u ON i.invited_user_id = u.id JOIN users ib ON i.invited_by = ib.id WHERE i.post_id = ? ORDER BY i.invited_at DESC, i.id DESC",
		[postId],
	);
	return rows;
}

export async function inviteUsersToHiddenPost(context: AppLoadContext, args: { postId: number; invitedBy: number; invitedUserIds: number[]; now?: number }) {
	const uniqueIds = Array.from(new Set(args.invitedUserIds.map((n) => Math.floor(n)).filter((n) => Number.isFinite(n) && n > 0)));
	if (uniqueIds.length === 0) {
		return { ok: true as const, inserted: [] as number[], skipped: [] as number[] };
	}
	const now = typeof args.now === "number" ? args.now : Date.now();
	const db = getDBFromContext(context);
	const inserted: number[] = [];
	const skipped: number[] = [];
	for (const userId of uniqueIds) {
		try {
			const res = await execute(
				db,
				"INSERT OR IGNORE INTO hidden_post_invites (post_id, invited_user_id, invited_by, invited_at, accepted_at, revoked_at, revoked_by) VALUES (?, ?, ?, ?, NULL, NULL, NULL)",
				[args.postId, userId, args.invitedBy, now],
			);
			if (Number(res.meta?.changes ?? 0) > 0) {
				inserted.push(userId);
			} else {
				skipped.push(userId);
			}
		} catch {
			skipped.push(userId);
		}
	}

	try {
		const active = await queryAll<{ invitedUserId: number }>(
			db,
			"SELECT invited_user_id as invitedUserId FROM hidden_post_invites WHERE post_id = ? AND revoked_at IS NULL ORDER BY invited_at DESC, id DESC",
			[args.postId],
		);
		const invitedUsers = active.map((r) => r.invitedUserId);
		await execute(db, "UPDATE posts SET invited_users = ? WHERE id = ?", [JSON.stringify(invitedUsers), args.postId]);
	} catch {
	}

	return { ok: true as const, inserted, skipped };
}

async function consumeAccessToken(context: AppLoadContext, args: { postId: number; userId: number; token: string; now: number }) {
	const db = getDBFromContext(context);
	const pepper = getTokenPepper(context);
	const tokenHash = await sha256Hex(`${pepper}:${args.token}`);
	const row = await queryOne<{ id: number; expiresAt: number; usedAt: number | null }>(
		db,
		"SELECT id as id, expires_at as expiresAt, used_at as usedAt FROM hidden_post_access_tokens WHERE post_id = ? AND user_id = ? AND token_hash = ? ORDER BY id DESC LIMIT 1",
		[args.postId, args.userId, tokenHash],
	);
	if (!row) return { ok: false as const, reason: "token_not_found" };
	// 移除过期检查和使用次数限制
	// if (args.now > Number(row.expiresAt ?? 0)) return { ok: false as const, reason: "token_expired" };
	// if (row.usedAt) return { ok: false as const, reason: "token_used" };

	// 仅记录访问时间，不限制后续访问
	try {
		await execute(
			db,
			"UPDATE hidden_post_access_tokens SET used_at = ? WHERE id = ?",
			[args.now, row.id],
		);
	} catch {
	}

	try {
		await execute(
			db,
			"UPDATE hidden_post_invites SET accepted_at = ? WHERE post_id = ? AND invited_user_id = ? AND revoked_at IS NULL AND accepted_at IS NULL",
			[args.now, args.postId, args.userId],
		);
	} catch {
	}
	return { ok: true as const };
}

export async function issueHiddenPostAccessToken(context: AppLoadContext, args: { postId: number; userId: number; issuedBy: number; now?: number; ttlMs?: number }) {
	const now = typeof args.now === "number" ? args.now : Date.now();
	const ttlMs = typeof args.ttlMs === "number" ? args.ttlMs : 7 * 24 * 60 * 60 * 1000;
	const expiresAt = now + ttlMs;
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const token = toBase64Url(bytes);
	const pepper = getTokenPepper(context);
	const tokenHash = await sha256Hex(`${pepper}:${token}`);
	const db = getDBFromContext(context);
	await execute(
		db,
		"INSERT INTO hidden_post_access_tokens (post_id, user_id, token_hash, issued_by, issued_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
		[args.postId, args.userId, tokenHash, args.issuedBy, now, expiresAt],
	);
	return { token, expiresAt };
}

export async function ensureHiddenPostReadable(args: {
	request: Request;
	context: AppLoadContext;
	postId: number;
	isHidden: boolean;
	user: AuthUser | null;
}) {
	if (!args.isHidden) {
		return { headers: undefined as HeadersInit | undefined };
	}
	// 仅允许 topadmin 直接访问所有隐藏内容
	if (args.user?.role === "topadmin") {
		return { headers: undefined as HeadersInit | undefined };
	}
	if (!args.user) {
		throw new Response("帖子不存在", { status: 404 });
	}

	const invited = await isInvited(args.context, args.postId, args.user.id);
	if (!invited) {
		throw new Response("帖子不存在", { status: 404 });
	}

	const session = await getSession(args.request, args.context);
	if (hasSessionAccess(session, args.postId)) {
		// 即使已有 session，也记录访问日志（如果需要）
		return { headers: undefined as HeadersInit | undefined };
	}

	const url = new URL(args.request.url);
	const token = String(url.searchParams.get("t") ?? "").trim();
	if (!token) {
		throw new Response("帖子不存在", { status: 404 });
	}

	const now = Date.now();
	const consumed = await consumeAccessToken(args.context, { postId: args.postId, userId: args.user.id, token, now });
	if (!consumed.ok) {
		throw new Response("帖子不存在", { status: 404 });
	}

	// 记录访问日志
	try {
		const db = getDBFromContext(args.context);
		const ip = args.request.headers.get("CF-Connecting-IP") || args.request.headers.get("X-Forwarded-For") || "unknown";
		const userAgent = args.request.headers.get("User-Agent") || "unknown";
		await execute(
			db,
			"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			[args.user.id, "hidden_post_accessed", ip, userAgent, JSON.stringify({ postId: args.postId, method: "token" }), now],
		);
	} catch {
	}

	grantSessionAccess(session, args.postId, now);
	const setCookie = await commitSession(session, args.request, args.context);
	return { headers: { "Set-Cookie": setCookie } };
}

export async function cleanupExpiredHiddenPostAccessTokens(context: AppLoadContext, now = Date.now()) {
	const db = getDBFromContext(context);
	try {
		await execute(db, "DELETE FROM hidden_post_access_tokens WHERE expires_at <= ? OR used_at IS NOT NULL", [now]);
	} catch {
	}
}
