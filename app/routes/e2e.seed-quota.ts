import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { attachmentStorageLimits } from "~/lib/attachments.server";
import { execute, getDBFromContext } from "~/lib/d1.server";

type ActionData = { ok: true } | { ok: false; error: string };

function isE2EEnabled(context: ActionFunctionArgs["context"]) {
	const env = (context as any).cloudflare?.env as any;
	return String(env?.E2E || "") === "1";
}

export async function action({ request, context }: ActionFunctionArgs) {
	if (!isE2EEnabled(context)) {
		throw new Response("Not Found", { status: 404 });
	}
	if (request.method !== "POST") {
		return json<ActionData>({ ok: false, error: "Method Not Allowed" }, { status: 405 });
	}
	const db = getDBFromContext(context);
	try {
		await execute(db, "PRAGMA foreign_keys=ON", []);
	} catch {
	}
	await execute(
		db,
		"INSERT OR IGNORE INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		[900001, "quota_seed@example.com", "seed", "x", "y", 0],
	);
	await execute(
		db,
		"INSERT OR IGNORE INTO posts (id, title, content, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		[900001, "seed", "seed", 900001, 0, 0],
	);
	await execute(
		db,
		"INSERT OR IGNORE INTO attachments (post_id, uploader_id, r2_key, filename, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[
			900001,
			900001,
			"seed/quota_full",
			"seed.bin",
			"application/octet-stream",
			attachmentStorageLimits.MAX_TOTAL_STORAGE_BYTES,
			Date.now(),
		],
	);
	return json<ActionData>({ ok: true });
}
