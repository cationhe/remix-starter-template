import type { AppLoadContext } from "@remix-run/cloudflare";
import { getDBFromContext, queryOne, execute } from "~/lib/d1.server";

type UserRecord = {
	id: number;
	email: string;
	display_name: string;
	password_hash: string;
	password_salt: string;
	created_at: number;
};

export type AuthUser = {
	id: number;
	email: string;
	displayName: string;
	createdAt: number;
};

function mapUser(record: UserRecord): AuthUser {
	return {
		id: record.id,
		email: record.email,
		displayName: record.display_name,
		createdAt: record.created_at,
	};
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

