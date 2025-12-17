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

async function hashPassword(password: string, salt: string) {
	return sha256(salt + ":" + password);
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
	const record = await queryOne<UserRecord>(
		db,
		"SELECT * FROM users WHERE email = ?",
		[email],
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
