import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getDBFromContext, queryAll } from "~/lib/d1.server";

type LogRow = {
	id: number;
	userId: number;
	eventType: string;
	metadataJson: string | null;
	createdAt: number;
};

type AuditLogRecord = {
	id: number;
	userId: number;
	eventType: string;
	createdAt: number;
	metadata: unknown;
};

type ActionData =
	| { ok: true; logs: AuditLogRecord[] }
	| { ok: false; error: string };

function isE2EEnabled(context: ActionFunctionArgs["context"]) {
	const env = (context as any).cloudflare?.env as any;
	return String(env?.E2E || "") === "1";
}

function parseLimit(value: unknown) {
	const num = typeof value === "number" ? value : Number(String(value || "").trim());
	if (!Number.isFinite(num)) return 50;
	return Math.min(200, Math.max(1, Math.floor(num)));
}

function safeParseJson(value: string | null) {
	if (!value) return null;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

export async function action({ request, context }: ActionFunctionArgs) {
	if (!isE2EEnabled(context)) {
		throw new Response("Not Found", { status: 404 });
	}
	if (request.method !== "POST") {
		return json<ActionData>({ ok: false, error: "Method Not Allowed" }, { status: 405 });
	}

	let eventType = "";
	let limit = 50;
	try {
		const contentType = request.headers.get("Content-Type") || "";
		if (contentType.includes("application/json")) {
			const body = (await request.json()) as any;
			eventType = String(body?.eventType || "").trim();
			limit = parseLimit(body?.limit);
		} else {
			const formData = await request.formData();
			eventType = String(formData.get("eventType") || "").trim();
			limit = parseLimit(formData.get("limit"));
		}
	} catch {
		eventType = "";
		limit = 50;
	}

	const db = getDBFromContext(context);
	const rows = await queryAll<LogRow>(
		db,
		eventType
			? "SELECT id as id, user_id as userId, event_type as eventType, metadata_json as metadataJson, created_at as createdAt FROM security_audit_logs WHERE event_type = ? ORDER BY created_at DESC, id DESC LIMIT ?"
			: "SELECT id as id, user_id as userId, event_type as eventType, metadata_json as metadataJson, created_at as createdAt FROM security_audit_logs ORDER BY created_at DESC, id DESC LIMIT ?",
		eventType ? [eventType, limit] : [limit],
	);

	return json<ActionData>({
		ok: true,
		logs: rows.map((r) => ({
			id: r.id,
			userId: r.userId,
			eventType: r.eventType,
			createdAt: r.createdAt,
			metadata: safeParseJson(r.metadataJson),
		})),
	});
}

