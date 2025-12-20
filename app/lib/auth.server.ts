import type { AppLoadContext } from "@remix-run/cloudflare";
import { redirect } from "@remix-run/cloudflare";
import { getDBFromContext, queryOne, execute } from "~/lib/d1.server";
import { getSession } from "~/lib/session.server";

type UserRecord = {
	id: number;
	email: string;
	display_name: string;
	password_hash: string;
	password_salt: string;
	created_at: number;
	role?: string;
	is_banned?: number;
	banned_at?: number | null;
};

export type UserRole = "superadmin" | "admin" | "user";

export type AuthUser = {
	id: number;
	email: string;
	displayName: string;
	createdAt: number;
	role: UserRole;
	isBanned: boolean;
	bannedAt: number | null;
};

export function isAdmin(user: AuthUser) {
	return user.role === "admin" || user.role === "superadmin";
}

export function assertNotBanned(user: AuthUser) {
	if (user.isBanned) {
		throw new Response("账号已被封禁", { status: 403 });
	}
}

export function assertAdmin(user: AuthUser) {
	if (!isAdmin(user)) {
		throw new Response("需要管理员权限", { status: 403 });
	}
}

export async function requireUserId(request: Request, context: AppLoadContext) {
	const session = await getSession(request, context);
	const userId = session.get("userId") as number | undefined;
	if (!userId) {
		throw redirect("/login");
	}
	return userId;
}

export async function requireUser(request: Request, context: AppLoadContext) {
	const userId = await requireUserId(request, context);
	const user = await findUserById(context, userId);
	if (!user) {
		throw redirect("/login");
	}
	return user;
}

function mapUser(record: UserRecord): AuthUser {
	return {
		id: record.id,
		email: record.email,
		displayName: record.display_name,
		createdAt: record.created_at,
		role: (record.role as UserRole) ?? "user",
		isBanned: Boolean(record.is_banned ?? 0),
		bannedAt: record.banned_at ?? null,
	};
}

function getEnv(context: AppLoadContext): Env {
	return (context as any).cloudflare.env as Env;
}

function getCrypto() {
	return crypto.subtle;
}

function toHex(data: Uint8Array) {
	return Array.from(data)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function fromRandomBytes(size: number) {
	const bytes = new Uint8Array(size);
	crypto.getRandomValues(bytes);
	return toHex(bytes);
}

async function sha256(input: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await getCrypto().digest("SHA-256", data);
	return toHex(new Uint8Array(hashBuffer));
}

function getEnvString(context: AppLoadContext, key: string) {
	const env = getEnv(context) as any;
	return String(env?.[key] ?? "").trim();
}

function normalizeUrl(base: string) {
	return base.replace(/\/$/, "");
}

async function resendSendEmail(context: AppLoadContext, args: { to: string; subject: string; text: string }) {
	const apiKey = getEnvString(context, "RESEND_API_KEY");
	const from = getEnvString(context, "EMAIL_FROM");
	if (!apiKey || !from) {
		throw new Error("EMAIL_NOT_CONFIGURED");
	}
	const resp = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from,
			to: args.to,
			subject: args.subject,
			text: args.text,
		}),
	});
	if (!resp.ok) {
		throw new Error("EMAIL_SEND_FAILED");
	}
}

function parseEmailAddress(input: string) {
	const trimmed = input.trim();
	const match = trimmed.match(/^(.*)<\s*([^>\s]+)\s*>\s*$/);
	if (!match) {
		return { email: trimmed };
	}
	const name = match[1].trim().replace(/^"|"$/g, "");
	const email = match[2].trim();
	return name ? { email, name } : { email };
}

async function mailchannelsSendEmail(
	context: AppLoadContext,
	args: { to: string; subject: string; text: string },
) {
	const fromRaw = getEnvString(context, "EMAIL_FROM");
	if (!fromRaw) {
		throw new Error("EMAIL_NOT_CONFIGURED");
	}
	const from = parseEmailAddress(fromRaw);
	const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			personalizations: [{ to: [{ email: args.to }] }],
			from,
			subject: args.subject,
			content: [{ type: "text/plain", value: args.text }],
		}),
	});
	if (!resp.ok) {
		throw new Error("EMAIL_SEND_FAILED");
	}
}

export async function sendEmail(context: AppLoadContext, args: { to: string; subject: string; text: string }) {
	const providerRaw = getEnvString(context, "EMAIL_PROVIDER").toLowerCase();
	const provider = providerRaw === "auto" ? "" : providerRaw;
	const hasResendKey = Boolean(getEnvString(context, "RESEND_API_KEY"));
	const selected = provider || (hasResendKey ? "resend" : "mailchannels");
	if (selected === "mailchannels") {
		return mailchannelsSendEmail(context, args);
	}
	return resendSendEmail(context, args);
}

type AuditEventType =
	| "pwd_code_send"
	| "pwd_code_send_failed"
	| "pwd_code_verify_ok"
	| "pwd_code_verify_failed"
	| "pwd_code_rate_limited"
	| "pwd_code_locked";

async function recordSecurityAuditEvent(args: {
	context: AppLoadContext;
	userId: number;
	eventType: AuditEventType;
	ip: string | null;
	userAgent: string | null;
	metadata?: Record<string, unknown>;
}) {
	try {
		const db = getDBFromContext(args.context);
		const createdAt = Date.now();
		await execute(
			db,
			"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			[
				args.userId,
				args.eventType,
				args.ip,
				args.userAgent,
				JSON.stringify(args.metadata ?? {}),
				createdAt,
			],
		);
	} catch {
		return;
	}
}

type UpstashResult<T> = { result?: T; error?: string };

function getUpstashConfig(context: AppLoadContext) {
	const url = getEnvString(context, "UPSTASH_REDIS_REST_URL");
	const token = getEnvString(context, "UPSTASH_REDIS_REST_TOKEN");
	if (!url || !token) {
		return null;
	}
	return { url: normalizeUrl(url), token };
}

async function upstashPipeline(context: AppLoadContext, commands: unknown[][]) {
	const cfg = getUpstashConfig(context);
	if (!cfg) {
		throw new Error("REDIS_NOT_CONFIGURED");
	}
	const resp = await fetch(`${cfg.url}/pipeline`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${cfg.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(commands),
	});
	if (!resp.ok) {
		throw new Error("REDIS_REQUEST_FAILED");
	}
	const data = (await resp.json()) as UpstashResult<unknown>[];
	if (!Array.isArray(data)) {
		throw new Error("REDIS_RESPONSE_INVALID");
	}
	return data;
}

async function redisGet(context: AppLoadContext, key: string) {
	const [res] = await upstashPipeline(context, [["GET", key]]);
	if (res?.error) {
		throw new Error("REDIS_GET_FAILED");
	}
	return (res?.result as string | null | undefined) ?? null;
}

async function redisDel(context: AppLoadContext, key: string) {
	const [res] = await upstashPipeline(context, [["DEL", key]]);
	if (res?.error) {
		throw new Error("REDIS_DEL_FAILED");
	}
}

async function redisSetEx(context: AppLoadContext, key: string, value: string, ttlSeconds: number) {
	const [res] = await upstashPipeline(context, [["SET", key, value, "EX", ttlSeconds]]);
	if (res?.error) {
		throw new Error("REDIS_SET_FAILED");
	}
}

async function redisIncrWithExpire(context: AppLoadContext, key: string, ttlSeconds: number) {
	const results = await upstashPipeline(context, [["INCR", key], ["TTL", key]]);
	const incr = results[0];
	const ttl = results[1];
	if (incr?.error || ttl?.error) {
		throw new Error("REDIS_INCR_FAILED");
	}
	const count = Number(incr?.result ?? 0);
	const ttlValue = Number(ttl?.result ?? -2);
	if (ttlValue < 0) {
		await upstashPipeline(context, [["EXPIRE", key, ttlSeconds]]);
	}
	return count;
}

function generateSixDigitCode() {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
	const code = value % 1_000_000;
	return code.toString().padStart(6, "0");
}

async function hashPasswordCode(context: AppLoadContext, userId: number, code: string) {
	const secret = getEnvString(context, "SESSION_SECRET");
	return sha256(`pwd_code:${userId}:${code}:${secret}`);
}

export async function sendPasswordChangeCode(args: {
	request: Request;
	context: AppLoadContext;
	user: AuthUser;
}) {
	const codeKey = `user:${args.user.id}:pwd_code`;
	const lockKey = `user:${args.user.id}:pwd_code_locked`;
	const sendKey = `user:${args.user.id}:pwd_code_send_cd`;
	const wrongKey = `user:${args.user.id}:pwd_code_wrong`;
	const now = Date.now();
	const ip = getClientIp(args.request);
	const userAgent = args.request.headers.get("User-Agent");

	const locked = await redisGet(args.context, lockKey);
	if (locked) {
		await recordSecurityAuditEvent({
			context: args.context,
			userId: args.user.id,
			eventType: "pwd_code_locked",
			ip,
			userAgent,
		});
		throw new Response("功能已锁定，请稍后再试", { status: 429 });
	}

	const cooldown = await redisGet(args.context, sendKey);
	if (cooldown) {
		await recordSecurityAuditEvent({
			context: args.context,
			userId: args.user.id,
			eventType: "pwd_code_rate_limited",
			ip,
			userAgent,
			metadata: { scope: "send" },
		});
		throw new Response("发送过于频繁，请稍后再试", { status: 429 });
	}

	const code = generateSixDigitCode();
	const hashed = await hashPasswordCode(args.context, args.user.id, code);
	await redisSetEx(args.context, codeKey, hashed, 15 * 60);
	await redisDel(args.context, wrongKey);

	const text =
		`你正在进行“修改密码”操作。\n\n` +
		`验证码：${code}\n` +
		`有效期：15 分钟\n\n` +
		`安全提示：请勿将验证码告知他人；如非本人操作，请尽快登录并修改密码。\n` +
		`操作时间：${new Date(now).toLocaleString()}`;

	try {
		await sendEmail(args.context, {
			to: args.user.email,
			subject: "修改密码验证码",
			text,
		});
		await redisSetEx(args.context, sendKey, "1", 60);
		await recordSecurityAuditEvent({
			context: args.context,
			userId: args.user.id,
			eventType: "pwd_code_send",
			ip,
			userAgent,
		});
		return { ok: true } as const;
	} catch (error) {
		await redisDel(args.context, codeKey);
		await recordSecurityAuditEvent({
			context: args.context,
			userId: args.user.id,
			eventType: "pwd_code_send_failed",
			ip,
			userAgent,
			metadata: { message: error instanceof Error ? error.message : "" },
		});
		throw error;
	}
}

export async function verifyPasswordChangeCode(args: {
	request: Request;
	context: AppLoadContext;
	user: AuthUser;
	code: string;
}) {
	const codeKey = `user:${args.user.id}:pwd_code`;
	const lockKey = `user:${args.user.id}:pwd_code_locked`;
	const wrongKey = `user:${args.user.id}:pwd_code_wrong`;
	const verifiedKey = `user:${args.user.id}:pwd_verified`;
	const ip = getClientIp(args.request);
	const userAgent = args.request.headers.get("User-Agent");

	const locked = await redisGet(args.context, lockKey);
	if (locked) {
		await recordSecurityAuditEvent({
			context: args.context,
			userId: args.user.id,
			eventType: "pwd_code_locked",
			ip,
			userAgent,
		});
		throw new Response("功能已锁定，请 5 分钟后再试", { status: 429 });
	}

	const bucket = Math.floor(Date.now() / 60_000);
	const attemptsKey = `user:${args.user.id}:pwd_code_attempts:${bucket}`;
	const attempts = await redisIncrWithExpire(args.context, attemptsKey, 60);
	if (attempts > 3) {
		await recordSecurityAuditEvent({
			context: args.context,
			userId: args.user.id,
			eventType: "pwd_code_rate_limited",
			ip,
			userAgent,
			metadata: { scope: "verify" },
		});
		throw new Response("请求过于频繁，请稍后再试", { status: 429 });
	}

	const storedHash = await redisGet(args.context, codeKey);
	if (!storedHash) {
		await recordSecurityAuditEvent({
			context: args.context,
			userId: args.user.id,
			eventType: "pwd_code_verify_failed",
			ip,
			userAgent,
			metadata: { reason: "expired" },
		});
		throw new Response("验证码已过期，请重新发送", { status: 400 });
	}

	const incoming = await hashPasswordCode(args.context, args.user.id, args.code);
	if (incoming !== storedHash) {
		const wrongCount = await redisIncrWithExpire(args.context, wrongKey, 5 * 60);
		await recordSecurityAuditEvent({
			context: args.context,
			userId: args.user.id,
			eventType: "pwd_code_verify_failed",
			ip,
			userAgent,
			metadata: { reason: "mismatch", wrongCount },
		});
		if (wrongCount >= 3) {
			await redisSetEx(args.context, lockKey, "1", 5 * 60);
			await redisDel(args.context, codeKey);
			throw new Response("验证码错误次数过多，功能已锁定 5 分钟", { status: 429 });
		}
		throw new Response("验证码错误", { status: 400 });
	}

	await redisSetEx(args.context, verifiedKey, "1", 15 * 60);
	await redisDel(args.context, codeKey);
	await redisDel(args.context, wrongKey);
	await recordSecurityAuditEvent({
		context: args.context,
		userId: args.user.id,
		eventType: "pwd_code_verify_ok",
		ip,
		userAgent,
	});
	return { ok: true } as const;
}

export async function assertPasswordChangeVerified(context: AppLoadContext, userId: number) {
	try {
		const verified = await redisGet(context, `user:${userId}:pwd_verified`);
		return Boolean(verified);
	} catch {
		return false;
	}
}

export async function clearPasswordChangeVerified(context: AppLoadContext, userId: number) {
	try {
		await redisDel(context, `user:${userId}:pwd_verified`);
	} catch {
		return;
	}
}

async function hashPassword(password: string, salt: string) {
	return sha256(salt + ":" + password);
}

function normalizeEmail(email: string) {
	return String(email || "").trim().toLowerCase();
}

export async function registerUser(
	context: AppLoadContext,
	email: string,
	displayName: string,
	password: string,
) {
	const db = getDBFromContext(context);
	const existing = await findUserByEmail(context, email);
	if (existing) {
		throw new Error("EMAIL_TAKEN");
	}
	const salt = fromRandomBytes(16);
	const hash = await hashPassword(password, salt);
	const createdAt = Date.now();
	await execute(
		db,
		"INSERT INTO users (email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
		[email, displayName, hash, salt, createdAt],
	);
	const user = await findUserByEmail(context, email);
	if (!user) {
		throw new Error("USER_CREATE_FAILED");
	}
	return user;
}

export async function findUserByEmail(context: AppLoadContext, email: string) {
	const db = getDBFromContext(context);
	const record = await queryOne<UserRecord>(
		db,
		"SELECT * FROM users WHERE email = ?",
		[email],
	);
	if (!record) {
		return null;
	}
	return mapUser(record);
}

export async function findUserById(context: AppLoadContext, id: number) {
	const db = getDBFromContext(context);
	const record = await queryOne<UserRecord>(
		db,
		"SELECT * FROM users WHERE id = ?",
		[id],
	);
	if (!record) {
		return null;
	}
	return mapUser(record);
}

export async function verifyLogin(
	context: AppLoadContext,
	email: string,
	password: string,
) {
	const db = getDBFromContext(context);
	const normalizedEmail = normalizeEmail(email);
	const record = await queryOne<UserRecord>(
		db,
		"SELECT * FROM users WHERE lower(email) = ?",
		[normalizedEmail],
	);
	if (!record) {
		return null;
	}
	const expected = await hashPassword(password, record.password_salt);
	if (expected !== record.password_hash) {
		return null;
	}
	return mapUser(record);
}

export async function changePassword(
	context: AppLoadContext,
	userId: number,
	oldPassword: string,
	newPassword: string,
) {
	const db = getDBFromContext(context);
	const record = await queryOne<UserRecord>(db, "SELECT * FROM users WHERE id = ?", [userId]);
	if (!record) {
		throw new Error("USER_NOT_FOUND");
	}
	const expected = await hashPassword(oldPassword, record.password_salt);
	if (expected !== record.password_hash) {
		throw new Error("OLD_PASSWORD_INCORRECT");
	}
	const salt = fromRandomBytes(16);
	const hash = await hashPassword(newPassword, salt);
	await execute(db, "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?", [
		hash,
		salt,
		userId,
	]);
}

export async function setPasswordByUserId(context: AppLoadContext, userId: number, newPassword: string) {
	const db = getDBFromContext(context);
	const record = await queryOne<UserRecord>(db, "SELECT id as id FROM users WHERE id = ?", [userId]);
	if (!record) {
		throw new Error("USER_NOT_FOUND");
	}
	const salt = fromRandomBytes(16);
	const hash = await hashPassword(newPassword, salt);
	await execute(db, "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?", [
		hash,
		salt,
		userId,
	]);
}

export async function promoteToSuperadminIfMatch(context: AppLoadContext, userId: number) {
	try {
		const env = getEnv(context);
		const superadminEmail = String(env.SUPERADMIN_EMAIL || "").trim().toLowerCase();
		if (!superadminEmail) {
			return;
		}
		const db = getDBFromContext(context);
		const record = await queryOne<UserRecord>(db, "SELECT * FROM users WHERE id = ?", [userId]);
		if (!record) {
			return;
		}
		if (record.email.toLowerCase() !== superadminEmail) {
			return;
		}
		if ((record.role as UserRole | undefined) === "superadmin") {
			return;
		}
		await execute(db, "UPDATE users SET role = 'superadmin' WHERE id = ?", [userId]);
	} catch {
		return;
	}
}

type RateLimitConfig = {
	windowMs: number;
	max: number;
	blockMs: number;
};

type RateLimitState = {
	count: number;
	windowStartedAt: number;
	blockedUntil: number | null;
};

export function getClientIp(request: Request) {
	const direct = request.headers.get("CF-Connecting-IP");
	if (direct) {
		const ip = direct.trim();
		return ip ? ip : null;
	}
	const forwarded = request.headers.get("X-Forwarded-For");
	if (forwarded) {
		const first = forwarded.split(",")[0]?.trim() ?? "";
		return first ? first : null;
	}
	return null;
}

export async function getRateLimitState(context: AppLoadContext, key: string, now = Date.now()) {
	const db = getDBFromContext(context);
	const record = await queryOne<RateLimitState>(
		db,
		"SELECT count as count, window_started_at as windowStartedAt, blocked_until as blockedUntil FROM auth_rate_limits WHERE key = ?",
		[key],
	);
	if (!record) {
		return { count: 0, windowStartedAt: now, blockedUntil: null };
	}
	return record;
}

export async function consumeRateLimit(context: AppLoadContext, key: string, config: RateLimitConfig, now = Date.now()) {
	const db = getDBFromContext(context);
	const state = await getRateLimitState(context, key, now);
	if (state.blockedUntil && state.blockedUntil > now) {
		return {
			allowed: false,
			blockedUntil: state.blockedUntil,
			count: state.count,
			remaining: 0,
		};
	}

	let windowStartedAt = state.windowStartedAt;
	let count = state.count;
	if (now - windowStartedAt >= config.windowMs) {
		windowStartedAt = now;
		count = 0;
	}
	count += 1;
	const blockedUntil = count >= config.max ? now + config.blockMs : null;
	const remaining = Math.max(0, config.max - count);

	await execute(
		db,
		"INSERT INTO auth_rate_limits (key, count, window_started_at, blocked_until, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at",
		[key, count, windowStartedAt, blockedUntil, now],
	);

	if (blockedUntil && blockedUntil > now) {
		return { allowed: false, blockedUntil, count, remaining };
	}
	return { allowed: true, blockedUntil: null, count, remaining };
}

export async function resetRateLimit(context: AppLoadContext, key: string, now = Date.now()) {
	const db = getDBFromContext(context);
	await execute(
		db,
		"INSERT INTO auth_rate_limits (key, count, window_started_at, blocked_until, updated_at) VALUES (?, 0, ?, NULL, ?) ON CONFLICT(key) DO UPDATE SET count = 0, window_started_at = excluded.window_started_at, blocked_until = NULL, updated_at = excluded.updated_at",
		[key, now, now],
	);
}
