import type { AppLoadContext } from "@remix-run/cloudflare";
import type { D1Database } from "@cloudflare/workers-types";

export function getDBFromContext(context: AppLoadContext): D1Database {
	return (context as any).cloudflare.env.DB as D1Database;
}

export async function queryAll<T>(db: D1Database, sql: string, params: unknown[] = []) {
	const stmt = db.prepare(sql);
	const result = await stmt.bind(...params).all<T>();
	return result.results ?? [];
}

export async function queryOne<T>(db: D1Database, sql: string, params: unknown[] = []) {
	const stmt = db.prepare(sql);
	const result = await stmt.bind(...params).first<T>();
	return result ?? null;
}

export async function execute(db: D1Database, sql: string, params: unknown[] = []) {
	const stmt = db.prepare(sql);
	return await stmt.bind(...params).run();
}
