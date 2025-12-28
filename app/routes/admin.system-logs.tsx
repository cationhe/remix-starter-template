import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useFetcher, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { getDBFromContext, queryAll } from "~/lib/d1.server";

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

type LogRow = {
	id: number;
	createdAt: number;
	level: LogLevel;
	userId: number;
	operatorDisplayName: string;
	operatorEmail: string;
	eventType: string;
	description: string;
	ipMasked: string;
};

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	eventTypes: string[];
	query: {
		quick: "today" | "week" | "month" | "custom";
		from: string;
		to: string;
		levels: LogLevel[];
		userId: string;
		operator: string;
		operatorId: string;
		eventType: string;
		q: string;
		qMode: "partial" | "exact";
		sortDir: "asc" | "desc";
		page: number;
		pageSize: number;
	};
	result: {
		items: LogRow[];
		total: number;
		totalPages: number;
		page: number;
		pageSize: number;
	};
};

type UsersResponse = { ok: true; users: { id: number; displayName: string; emailMasked: string; role: string }[] };

function parseIntOrNull(value: string | null) {
	if (!value) return null;
	const n = Number(String(value).trim());
	if (!Number.isFinite(n)) return null;
	return Math.trunc(n);
}

function parseMsOrNull(value: string | null) {
	if (!value) return null;
	const s = String(value).trim();
	if (!s) return null;
	if (/^\d+$/.test(s)) {
		const n = Number(s);
		return Number.isFinite(n) ? Math.trunc(n) : null;
	}
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : null;
}

function clamp(n: number, min: number, max: number) {
	return Math.max(min, Math.min(max, n));
}

function normalizeLevelsParam(value: string | null): LogLevel[] {
	const raw = String(value ?? "")
		.split(",")
		.map((s) => s.trim().toUpperCase())
		.filter(Boolean);
	const out: LogLevel[] = [];
	for (const v of raw) {
		if (v === "INFO" || v === "WARN" || v === "ERROR" || v === "DEBUG") out.push(v);
	}
	return Array.from(new Set(out));
}

function getLevelsFromSearchParams(sp: URLSearchParams): LogLevel[] {
	const all = sp
		.getAll("levels")
		.map((s) => String(s).trim().toUpperCase())
		.filter(Boolean);
	if (all.length) return normalizeLevelsParam(all.join(","));
	return normalizeLevelsParam(sp.get("levels"));
}

function escapeLike(value: string) {
	return String(value).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildChineseLoosePattern(value: string) {
	const chars = Array.from(value).filter((c) => c.trim().length > 0);
	if (chars.length <= 1) return null;
	return `%${chars.map((c) => escapeLike(c)).join("%")}%`;
}

function normalizeOperatorKeyword(value: string) {
	return String(value)
		.trim()
		.replace(/[\u3000\s]+/g, " ")
		.replace(/[，。；、]+/g, " ")
		.slice(0, 80);
}

function startOfTodayMs(now = Date.now()) {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function startOfWeekMs(now = Date.now()) {
	const d = new Date(now);
	const day = d.getDay();
	const diff = day === 0 ? -6 : 1 - day;
	d.setDate(d.getDate() + diff);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function startOfMonthMs(now = Date.now()) {
	const d = new Date(now);
	d.setDate(1);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function safeParseJson(value: string | null) {
	if (!value) return null;
	try {
		return JSON.parse(value) as any;
	} catch {
		return null;
	}
}

function maskEmail(email: string | null) {
	if (!email) return "";
	const parts = email.split("@");
	if (parts.length !== 2) return "";
	const local = parts[0] ?? "";
	const domain = parts[1] ?? "";
	if (!local) return `***@${domain}`;
	const head = local.slice(0, 1);
	return `${head}***@${domain}`;
}

function maskIp(ip: string | null) {
	const raw = String(ip ?? "").trim();
	if (!raw) return "";
	if (raw.includes(".")) {
		const parts = raw.split(".");
		if (parts.length === 4) {
			return `${parts[0]}.${parts[1]}.*.*`;
		}
		return raw;
	}
	if (raw.includes(":")) {
		const parts = raw.split(":");
		return `${parts.slice(0, 3).join(":")}:*:*:*:*:*`;
	}
	return raw;
}

function computeLevelFromEventType(eventType: string): LogLevel {
	const t = String(eventType || "").toLowerCase();
	if (!t) return "INFO";
	if (t.includes("debug")) return "DEBUG";
	if (t.includes("_failed") || t.includes("error") || t.includes("exception")) return "ERROR";
	if (t.includes("_denied") || t.includes("rate_limited") || t.includes("locked") || t.includes("warning")) return "WARN";
	return "INFO";
}

function formatDescription(eventType: string, metadataJson: string | null) {
	const meta = safeParseJson(metadataJson);
	const t = String(eventType || "");
	if (t === "user_role_updated") {
		const targetEmail = typeof meta?.targetEmail === "string" ? meta.targetEmail : "";
		const prevRole = typeof meta?.prevRole === "string" ? meta.prevRole : "";
		const nextRole = typeof meta?.nextRole === "string" ? meta.nextRole : "";
		return `修改用户角色：${maskEmail(targetEmail)} ${prevRole} → ${nextRole}`.trim();
	}
	if (t === "discussion_area_updated") {
		const areaId = Number(meta?.areaId ?? 0);
		const name = typeof meta?.name === "string" ? meta.name : "";
		return areaId ? `修改讨论区：#${areaId} ${name}`.trim() : "修改讨论区";
	}
	if (t === "discussion_area_visibility_updated") {
		const areaId = Number(meta?.areaId ?? 0);
		const hidden = Number(meta?.hidden ?? -1);
		return areaId ? `修改讨论区可见性：#${areaId} ${hidden === 1 ? "隐藏" : "公开"}` : "修改讨论区可见性";
	}
	if (t === "site_total_storage_limit_updated") {
		const prevBytes = Number(meta?.prevBytes ?? 0);
		const nextBytes = Number(meta?.nextBytes ?? 0);
		return `调整网站总存储上限：${prevBytes} → ${nextBytes}`;
	}
	if (t === "site_total_storage_limit_update_failed") {
		return "调整网站总存储上限失败";
	}
	if (t === "posts_banned_bulk_deleted") {
		const count = Number(meta?.count ?? meta?.deletedCount ?? 0);
		return count ? `批量永久删除封禁帖子：${count} 条` : "批量永久删除封禁帖子";
	}
	if (t === "discussion_area_attachment_download_denied" || t === "discussion_area_comment_attachment_download_denied") {
		const postId = Number(meta?.postId ?? 0);
		return postId ? `附件下载被拒：postId=${postId}` : "附件下载被拒";
	}
	if (t === "turnstile_missing_token" || t === "turnstile_verify_failed") {
		return "Turnstile 校验失败";
	}
	if (t === "daily_quota_exceeded") {
		const kind = typeof meta?.kind === "string" ? meta.kind : "";
		return kind ? `触发每日限额：${kind}` : "触发每日限额";
	}
	if (t === "hidden_post_accessed") {
		const postId = Number(meta?.postId ?? 0);
		return postId ? `访问隐藏帖：postId=${postId}` : "访问隐藏帖";
	}
	if (t === "admin_message_sent") {
		return "管理员发送消息";
	}
	if (t === "comment_attachment_upload_ok") {
		return "评论附件上传成功";
	}
	if (t === "comment_attachment_upload_failed") {
		return "评论附件上传失败";
	}
	if (t.endsWith("_failed")) {
		return `${t}（失败）`;
	}
	if (t.endsWith("_denied")) {
		return `${t}（拒绝）`;
	}
	return t;
}

function truncateText(value: string, maxLen: number) {
	const s = String(value ?? "");
	if (s.length <= maxLen) return s;
	return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

async function getDefaultCache() {
	const anyCaches = caches as any;
	if (anyCaches?.default) return anyCaches.default as Cache;
	return await caches.open("default");
}

async function getEventTypesWithCache(context: LoaderFunctionArgs["context"], meId: number) {
	const cache = await getDefaultCache();
	const cacheKey = new Request(`https://cache.local/admin/system-logs/event-types?uid=${meId}`);
	const cached = await cache.match(cacheKey);
	if (cached) {
		try {
			return (await cached.json()) as string[];
		} catch {
		}
	}
	const db = getDBFromContext(context);
	const rows = await queryAll<{ eventType: string }>(
		db,
		"SELECT DISTINCT event_type as eventType FROM security_audit_logs ORDER BY event_type ASC LIMIT 500",
	);
	const list = rows.map((r) => String(r.eventType || "").trim()).filter(Boolean);
	await cache.put(
		cacheKey,
		new Response(JSON.stringify(list), {
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "max-age=600",
			},
		}),
	);
	return list;
}

function buildLogWhere(args: {
	fromMs: number;
	toMs: number;
	levels: LogLevel[];
	operatorText: string;
	operatorId: number | null;
	userId: number | null;
	eventType: string;
	q: string;
	qMode: "partial" | "exact";
}) {
	const where: string[] = [];
	const params: unknown[] = [];

	where.push("createdAt >= ? AND createdAt <= ?");
	params.push(args.fromMs);
	params.push(args.toMs);

	if (args.userId !== null) {
		where.push("userId = ?");
		params.push(args.userId);
	} else if (args.operatorId !== null) {
		where.push("userId = ?");
		params.push(args.operatorId);
	}

	if (args.eventType) {
		where.push("eventType = ?");
		params.push(args.eventType);
	}

	const operatorText = normalizeOperatorKeyword(args.operatorText);
	if (operatorText && args.operatorId === null && args.userId === null) {
		const like = `%${escapeLike(operatorText)}%`;
		const loose = buildChineseLoosePattern(operatorText);
		const pieces: string[] = [];
		pieces.push("operatorDisplayName LIKE ? ESCAPE '\\'");
		params.push(like);
		if (loose) {
			pieces.push("operatorDisplayName LIKE ? ESCAPE '\\'");
			params.push(loose);
		}
		const operatorIdMaybe = /^\d+$/.test(operatorText) ? parseIntOrNull(operatorText) : null;
		if (operatorIdMaybe !== null && operatorIdMaybe >= 0) {
			pieces.push("userId = ?");
			params.push(operatorIdMaybe);
		}
		const roleMap: Record<string, string> = {
			"超管": "superadmin",
			"超级管理员": "superadmin",
			"站长": "topadmin",
			"管理员": "admin",
		};
		for (const [k, v] of Object.entries(roleMap)) {
			if (operatorText.includes(k)) {
				pieces.push("userId IN (SELECT id FROM users WHERE role = ?)");
				params.push(v);
			}
		}
		where.push(`(${pieces.join(" OR ")})`);
	}

	if (args.q) {
		const q = String(args.q).trim().slice(0, 120);
		if (q) {
			if (args.qMode === "exact") {
				where.push("descriptionSearch = ?");
				params.push(q);
			} else {
				where.push("descriptionSearch LIKE ? ESCAPE '\\'");
				params.push(`%${escapeLike(q)}%`);
			}
		}
	}

	if (args.levels.length > 0) {
		where.push(`level IN (${args.levels.map(() => "?").join(",")})`);
		params.push(...args.levels);
	}

	return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

async function queryLogsPage(args: {
	context: LoaderFunctionArgs["context"];
	fromMs: number;
	toMs: number;
	levels: LogLevel[];
	operatorText: string;
	operatorId: number | null;
	userId: number | null;
	eventType: string;
	q: string;
	qMode: "partial" | "exact";
	page: number;
	pageSize: number;
	sortDir: "asc" | "desc";
}) {
	const db = getDBFromContext(args.context);
	const baseSelect = `
		SELECT
			l.id as id,
			l.created_at as createdAt,
			l.user_id as userId,
			COALESCE(u.display_name, '') as operatorDisplayName,
			COALESCE(u.email, '') as operatorEmail,
			l.event_type as eventType,
			l.ip as ip,
			l.metadata_json as metadataJson,
			CASE
				WHEN LOWER(l.event_type) LIKE '%debug%' THEN 'DEBUG'
				WHEN LOWER(l.event_type) LIKE '%_failed' OR LOWER(l.event_type) LIKE '%error%' OR LOWER(l.event_type) LIKE '%exception%' THEN 'ERROR'
				WHEN LOWER(l.event_type) LIKE '%_denied' OR LOWER(l.event_type) LIKE '%rate_limited%' OR LOWER(l.event_type) LIKE '%locked%' OR LOWER(l.event_type) LIKE '%warning%' THEN 'WARN'
				ELSE 'INFO'
			END as level,
			CASE
				WHEN l.event_type = 'user_role_updated' THEN '修改用户角色：' || COALESCE(json_extract(l.metadata_json, '$.targetEmail'), '') || ' ' || COALESCE(json_extract(l.metadata_json, '$.prevRole'), '') || ' → ' || COALESCE(json_extract(l.metadata_json, '$.nextRole'), '')
				WHEN l.event_type = 'discussion_area_updated' THEN '修改讨论区：#' || COALESCE(CAST(json_extract(l.metadata_json, '$.areaId') AS TEXT), '') || ' ' || COALESCE(json_extract(l.metadata_json, '$.name'), '')
				WHEN l.event_type = 'discussion_area_visibility_updated' THEN '修改讨论区可见性：#' || COALESCE(CAST(json_extract(l.metadata_json, '$.areaId') AS TEXT), '')
				WHEN l.event_type = 'site_total_storage_limit_updated' THEN '调整网站总存储上限'
				WHEN l.event_type = 'site_total_storage_limit_update_failed' THEN '调整网站总存储上限失败'
				WHEN l.event_type = 'posts_banned_bulk_deleted' THEN '批量永久删除封禁帖子'
				WHEN l.event_type = 'discussion_area_attachment_download_denied' OR l.event_type = 'discussion_area_comment_attachment_download_denied' THEN '附件下载被拒'
				WHEN l.event_type = 'turnstile_missing_token' OR l.event_type = 'turnstile_verify_failed' THEN 'Turnstile 校验失败'
				WHEN l.event_type = 'daily_quota_exceeded' THEN '触发每日限额'
				WHEN l.event_type = 'hidden_post_accessed' THEN '访问隐藏帖'
				WHEN l.event_type = 'admin_message_sent' THEN '管理员发送消息'
				WHEN l.event_type = 'comment_attachment_upload_ok' THEN '评论附件上传成功'
				WHEN l.event_type = 'comment_attachment_upload_failed' THEN '评论附件上传失败'
				ELSE l.event_type
			END as descriptionSearch
		FROM security_audit_logs l
		LEFT JOIN users u ON u.id = l.user_id
	`;

	const { whereSql, params } = buildLogWhere({
		fromMs: args.fromMs,
		toMs: args.toMs,
		levels: args.levels,
		operatorText: args.operatorText,
		operatorId: args.operatorId,
		userId: args.userId,
		eventType: args.eventType,
		q: args.q,
		qMode: args.qMode,
	});

	const totalRows = await queryAll<{ total: number }>(
		db,
		`SELECT COUNT(*) as total FROM (${baseSelect}) ${whereSql}`,
		params,
	);
	const total = Number(totalRows?.[0]?.total ?? 0);
	const pageSize = args.pageSize;
	const totalPages = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
	const page = clamp(args.page, 1, totalPages);
	const offset = (page - 1) * pageSize;
	const orderBy = args.sortDir === "asc" ? "createdAt ASC, id ASC" : "createdAt DESC, id DESC";
	const rows = await queryAll<{
		id: number;
		createdAt: number;
		level: LogLevel;
		userId: number;
		operatorDisplayName: string | null;
		operatorEmail: string | null;
		eventType: string;
		ip: string | null;
		metadataJson: string | null;
	}>(
		db,
		`SELECT id, createdAt, level, userId, operatorDisplayName, operatorEmail, eventType, ip, metadataJson FROM (${baseSelect}) ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
		[...params, pageSize, offset],
	);

	const items: LogRow[] = rows.map((r) => {
		const eventType = String(r.eventType || "");
		const level = r.level || computeLevelFromEventType(eventType);
		const displayName = r.operatorDisplayName ? String(r.operatorDisplayName) : "";
		const emailMasked = maskEmail(r.operatorEmail);
		const operator = truncateText(displayName || emailMasked || `用户#${r.userId}`, 40);
		const description = truncateText(formatDescription(eventType, r.metadataJson), 120);
		return {
			id: Number(r.id),
			createdAt: Number(r.createdAt),
			level,
			userId: Number(r.userId),
			operatorDisplayName: operator,
			operatorEmail: emailMasked,
			eventType: eventType,
			description,
			ipMasked: maskIp(r.ip),
		};
	});

	return { items, total, totalPages, page, pageSize };
}

function escapeCsvCell(value: string) {
	const s = String(value ?? "");
	if (/[\n\r",]/.test(s)) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

function exportAsCsv(rows: LogRow[]) {
	const header = ["时间戳", "日志级别", "操作人", "操作类型", "操作描述", "IP地址"].join(",");
	const lines = rows.map((r) => {
		return [
			escapeCsvCell(new Date(r.createdAt).toLocaleString()),
			escapeCsvCell(r.level),
			escapeCsvCell(r.operatorDisplayName),
			escapeCsvCell(r.eventType),
			escapeCsvCell(r.description),
			escapeCsvCell(r.ipMasked),
		].join(",");
	});
	return `\uFEFF${[header, ...lines].join("\n")}`;
}

function escapeHtml(value: string) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function exportAsExcelHtml(rows: LogRow[]) {
	const thead =
		"<tr><th>时间戳</th><th>日志级别</th><th>操作人</th><th>操作类型</th><th>操作描述</th><th>IP地址</th></tr>";
	const tbody = rows
		.map((r) => {
			return `<tr><td>${escapeHtml(new Date(r.createdAt).toLocaleString())}</td><td>${escapeHtml(r.level)}</td><td>${escapeHtml(
				r.operatorDisplayName,
			)}</td><td>${escapeHtml(r.eventType)}</td><td>${escapeHtml(r.description)}</td><td>${escapeHtml(r.ipMasked)}</td></tr>`;
		})
		.join("");
	return `<!doctype html><html><head><meta charset="utf-8" /></head><body><table border="1"><thead>${thead}</thead><tbody>${tbody}</tbody></table></body></html>`;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (me.role !== "topadmin") {
		throw new Response("只有站点管理员可访问", { status: 403 });
	}

	const url = new URL(request.url);
	const wantUsers = url.searchParams.get("users") === "1";
	if (wantUsers) {
		const operatorText = normalizeOperatorKeyword(url.searchParams.get("operator") || "");
		if (!operatorText) return json<UsersResponse>({ ok: true, users: [] }, { headers: { "Cache-Control": "no-store" } });

		const like = `%${escapeLike(operatorText)}%`;
		const loose = buildChineseLoosePattern(operatorText);
		const operatorIdMaybe = /^\d+$/.test(operatorText) ? parseIntOrNull(operatorText) : null;
		const roleMap: Record<string, string> = {
			"超管": "superadmin",
			"超级管理员": "superadmin",
			"站长": "topadmin",
			"管理员": "admin",
		};

		const where: string[] = [];
		const params: unknown[] = [];
		where.push("COALESCE(display_name, '') LIKE ? ESCAPE '\\'");
		params.push(like);
		if (loose) {
			where.push("COALESCE(display_name, '') LIKE ? ESCAPE '\\'");
			params.push(loose);
		}
		where.push("COALESCE(email, '') LIKE ? ESCAPE '\\'");
		params.push(like);
		if (operatorIdMaybe !== null && operatorIdMaybe >= 0) {
			where.push("id = ?");
			params.push(operatorIdMaybe);
		}
		for (const [k, v] of Object.entries(roleMap)) {
			if (operatorText.includes(k)) {
				where.push("COALESCE(role, '') = ?");
				params.push(v);
			}
		}

		const db = getDBFromContext(context);
		const users = await queryAll<{ id: number; displayName: string | null; email: string | null; role: string | null }>(
			db,
			`SELECT id, COALESCE(display_name, '') as displayName, COALESCE(email, '') as email, COALESCE(role, '') as role FROM users WHERE (${where.join(
				" OR ",
			)}) ORDER BY id DESC LIMIT 20`,
			params,
		);
		return json<UsersResponse>(
			{
				ok: true,
				users: users.map((u) => ({
					id: Number(u.id),
					displayName: String(u.displayName || "").trim() || `用户#${u.id}`,
					emailMasked: maskEmail(u.email),
					role: String(u.role || ""),
				})),
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	}

	const now = Date.now();
	const quickRaw = String(url.searchParams.get("quick") || "").trim();
	const quick: LoaderData["query"]["quick"] =
		quickRaw === "today" || quickRaw === "week" || quickRaw === "month" || quickRaw === "custom" ? quickRaw : "week";
	const fromTextRaw = String(url.searchParams.get("from") || "").trim();
	const toTextRaw = String(url.searchParams.get("to") || "").trim();
	let fromMs = parseMsOrNull(fromTextRaw);
	let toMs = parseMsOrNull(toTextRaw);

	if (quick !== "custom" || fromMs === null || toMs === null) {
		if (quick === "today") {
			fromMs = startOfTodayMs(now);
			toMs = now;
		} else if (quick === "month") {
			fromMs = startOfMonthMs(now);
			toMs = now;
		} else {
			fromMs = startOfWeekMs(now);
			toMs = now;
		}
	}
	fromMs = clamp(fromMs ?? startOfWeekMs(now), 0, now);
	toMs = clamp(toMs ?? now, 0, now);
	if (fromMs > toMs) {
		const tmp = fromMs;
		fromMs = toMs;
		toMs = tmp;
	}

	const levels = (() => {
		const parsed = getLevelsFromSearchParams(url.searchParams);
		return parsed.length ? parsed : (["INFO", "WARN", "ERROR"] as LogLevel[]);
	})();
	const operatorText = String(url.searchParams.get("operator") || "").trim().slice(0, 80);
	const operatorIdRaw = parseIntOrNull(url.searchParams.get("operatorId"));
	const operatorId = operatorIdRaw !== null && operatorIdRaw >= 0 ? operatorIdRaw : null;
	const userIdRaw = parseIntOrNull(url.searchParams.get("userId"));
	const userId = userIdRaw !== null && userIdRaw >= 0 ? userIdRaw : null;
	const eventType = String(url.searchParams.get("eventType") || "").trim().slice(0, 120);
	const q = String(url.searchParams.get("q") || "").trim().slice(0, 120);
	const qMode: LoaderData["query"]["qMode"] =
		String(url.searchParams.get("qMode") || "partial") === "exact" ? "exact" : "partial";
	const sortDir: LoaderData["query"]["sortDir"] =
		String(url.searchParams.get("sortDir") || "desc") === "asc" ? "asc" : "desc";
	const pageSize = 20;
	const page = clamp(parseIntOrNull(url.searchParams.get("page")) ?? 1, 1, 1000000);
	const exportMode = String(url.searchParams.get("export") || "").trim();

	const eventTypes = await getEventTypesWithCache(context, me.id);

	const doQuery = async (args?: { page?: number; pageSize?: number }) => {
		return await queryLogsPage({
			context,
			fromMs,
			toMs,
			levels,
			operatorText,
			operatorId,
			userId,
			eventType,
			q,
			qMode,
			page: args?.page ?? page,
			pageSize: args?.pageSize ?? pageSize,
			sortDir,
		});
	};

	if (exportMode === "csv" || exportMode === "excel") {
		const result = await doQuery({ page: 1, pageSize: 5000 });
		if (exportMode === "csv") {
			const body = exportAsCsv(result.items);
			return new Response(body, {
				headers: {
					"Content-Type": "text/csv; charset=utf-8",
					"Content-Disposition": `attachment; filename=system-logs-${Date.now()}.csv`,
					"Cache-Control": "no-store",
				},
			});
		}
		const body = exportAsExcelHtml(result.items);
		return new Response(body, {
			headers: {
				"Content-Type": "application/vnd.ms-excel; charset=utf-8",
				"Content-Disposition": `attachment; filename=system-logs-${Date.now()}.xls`,
				"Cache-Control": "no-store",
			},
		});
	}

	const result = await doQuery();
	const query: LoaderData["query"] = {
		quick,
		from: quick === "custom" ? fromTextRaw || new Date(fromMs).toISOString().slice(0, 16) : "",
		to: quick === "custom" ? toTextRaw || new Date(toMs).toISOString().slice(0, 16) : "",
		levels,
		userId: userIdRaw !== null ? String(userIdRaw) : "",
		operator: operatorText,
		operatorId: operatorIdRaw !== null ? String(operatorIdRaw) : "",
		eventType,
		q,
		qMode,
		sortDir,
		page: result.page,
		pageSize: result.pageSize,
	};
	return json<LoaderData>({ me, eventTypes, query, result });
}

function levelBadgeClass(level: LogLevel) {
	if (level === "ERROR") return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-200";
	if (level === "WARN") return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200";
	if (level === "DEBUG") return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-200";
	return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-200";
}

export default function AdminSystemLogsPage() {
	const data = useLoaderData<LoaderData>();
	const eventTypes = (data.eventTypes ?? []) as string[];
	const navigation = useNavigation();
	const isLoading = navigation.state !== "idle";

	const usersFetcher = useFetcher<UsersResponse>();
	const usersDebounceTimerRef = useRef<number | null>(null);

	const [operatorIdText, setOperatorIdText] = useState(data.query.operatorId || "");
	const [operatorText, setOperatorText] = useState(data.query.operator || "");
	const [quick, setQuick] = useState<LoaderData["query"]["quick"]>(data.query.quick);
	const [fromText, setFromText] = useState(data.query.from || "");
	const [toText, setToText] = useState(data.query.to || "");
	const [levels, setLevels] = useState<LogLevel[]>(data.query.levels);
	const [userIdText, setUserIdText] = useState(data.query.userId || "");
	const [eventType, setEventType] = useState(data.query.eventType || "");
	const [q, setQ] = useState(data.query.q || "");
	const [qMode, setQMode] = useState<LoaderData["query"]["qMode"]>(data.query.qMode);
	const [sortDir, setSortDir] = useState<LoaderData["query"]["sortDir"]>(data.query.sortDir);

	useEffect(() => {
		setOperatorIdText(data.query.operatorId || "");
		setOperatorText(data.query.operator || "");
		setQuick(data.query.quick);
		setFromText(data.query.from || "");
		setToText(data.query.to || "");
		setLevels(data.query.levels);
		setUserIdText(data.query.userId || "");
		setEventType(data.query.eventType || "");
		setQ(data.query.q || "");
		setQMode(data.query.qMode);
		setSortDir(data.query.sortDir);
	}, [
		data.query.eventType,
		data.query.from,
		data.query.levels,
		data.query.operator,
		data.query.operatorId,
		data.query.q,
		data.query.qMode,
		data.query.quick,
		data.query.sortDir,
		data.query.to,
		data.query.userId,
	]);

	useEffect(() => {
		if (usersDebounceTimerRef.current) {
			window.clearTimeout(usersDebounceTimerRef.current);
			usersDebounceTimerRef.current = null;
		}
		const text = operatorText.trim();
		if (!text) return;
		if (operatorIdText) return;
		usersDebounceTimerRef.current = window.setTimeout(() => {
			usersFetcher.load(`/admin/system-logs?users=1&operator=${encodeURIComponent(text)}`);
		}, 300);
		return () => {
			if (usersDebounceTimerRef.current) {
				window.clearTimeout(usersDebounceTimerRef.current);
				usersDebounceTimerRef.current = null;
			}
		};
	}, [operatorText, operatorIdText, usersFetcher]);

	const baseSearchParams = useMemo(() => {
		const sp = new URLSearchParams();
		sp.set("quick", quick);
		if (quick === "custom") {
			if (fromText) sp.set("from", fromText);
			if (toText) sp.set("to", toText);
		}
		for (const l of levels) sp.append("levels", l);
		if (userIdText.trim()) sp.set("userId", userIdText.trim());
		if (operatorText.trim()) sp.set("operator", operatorText.trim());
		if (operatorIdText.trim()) sp.set("operatorId", operatorIdText.trim());
		if (eventType) sp.set("eventType", eventType);
		if (q.trim()) sp.set("q", q.trim());
		sp.set("qMode", qMode);
		sp.set("sortDir", sortDir);
		return sp;
	}, [quick, fromText, toText, levels, userIdText, operatorText, operatorIdText, eventType, q, qMode, sortDir]);

	const exportCsvHref = useMemo(() => {
		const sp = new URLSearchParams(baseSearchParams);
		sp.delete("page");
		sp.set("export", "csv");
		return `/admin/system-logs?${sp.toString()}`;
	}, [baseSearchParams]);

	const exportExcelHref = useMemo(() => {
		const sp = new URLSearchParams(baseSearchParams);
		sp.delete("page");
		sp.set("export", "excel");
		return `/admin/system-logs?${sp.toString()}`;
	}, [baseSearchParams]);

	function resetFilters() {
		setQuick("week");
		setFromText("");
		setToText("");
		setLevels(["INFO", "WARN", "ERROR"]);
		setUserIdText("");
		setOperatorText("");
		setOperatorIdText("");
		setEventType("");
		setQ("");
		setQMode("partial");
		setSortDir("desc");
	}

	const items = data.result.items;
	const page = data.result.page;
	const totalPages = data.result.totalPages;
	const total = data.result.total;

	const pagination = useMemo(() => {
		const out: Array<number | "…"> = [];
		const add = (v: number | "…") => {
			if (out[out.length - 1] === v) return;
			out.push(v);
		};
		if (totalPages <= 9) {
			for (let i = 1; i <= totalPages; i++) add(i);
			return out;
		}
		add(1);
		if (page > 4) add("…");
		const start = Math.max(2, page - 2);
		const end = Math.min(totalPages - 1, page + 2);
		for (let i = start; i <= end; i++) add(i);
		if (page < totalPages - 3) add("…");
		add(totalPages);
		return out;
	}, [page, totalPages]);

	function pageHref(nextPage: number) {
		const sp = new URLSearchParams(baseSearchParams);
		sp.set("page", String(nextPage));
		return `/admin/system-logs?${sp.toString()}`;
	}

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
				<header className="flex flex-col gap-2">
					<div className="text-sm text-gray-600 dark:text-gray-300">
						<Link to="/admin/users" className="hover:underline">
							管理后台
						</Link>
						<span className="mx-2 text-gray-400">/</span>
						<span className="text-gray-900 dark:text-gray-100">系统日志查询</span>
					</div>
					<div className="flex items-center justify-between gap-3">
						<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">系统日志查询</h1>
						<div className="flex flex-wrap items-center gap-2">
							<a
								href={exportCsvHref}
								className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
							>
								导出 CSV
							</a>
							<a
								href={exportExcelHref}
								className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
							>
								导出 Excel
							</a>
							<Link
								to="/posts"
								className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
							>
								返回论坛
							</Link>
						</div>
					</div>
				</header>

				{isLoading ? (
					<div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:border-blue-900/50 dark:bg-blue-900/20 dark:text-blue-200">
						正在查询…
					</div>
				) : null}

				<div className="grid gap-4 md:grid-cols-[320px_1fr]">
					<section className="rounded-xl border border-gray-200 bg-white p-4 shadow dark:border-gray-800 dark:bg-gray-900">
						<div className="text-sm font-semibold text-gray-900 dark:text-gray-100">查询条件</div>
						<form method="get" className="mt-4 grid gap-4">
							<input type="hidden" name="quick" value={quick} />
							<input type="hidden" name="qMode" value={qMode} />
							<input type="hidden" name="sortDir" value={sortDir} />
							<input type="hidden" name="page" value="1" />
							{operatorIdText ? <input type="hidden" name="operatorId" value={operatorIdText} /> : null}
							<div>
								<div className="text-sm font-medium text-gray-700 dark:text-gray-200">时间范围</div>
								<div className="mt-2 flex flex-wrap gap-2">
									<button
										type="button"
										onClick={() => setQuick("today")}
										className={
											quick === "today"
												? "rounded bg-blue-600 px-3 py-1 text-sm text-white"
												: "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										}
									>
										今天
									</button>
									<button
										type="button"
										onClick={() => setQuick("week")}
										className={
											quick === "week"
												? "rounded bg-blue-600 px-3 py-1 text-sm text-white"
												: "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										}
									>
										本周
									</button>
									<button
										type="button"
										onClick={() => setQuick("month")}
										className={
											quick === "month"
												? "rounded bg-blue-600 px-3 py-1 text-sm text-white"
												: "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										}
									>
										本月
									</button>
									<button
										type="button"
										onClick={() => setQuick("custom")}
										className={
											quick === "custom"
												? "rounded bg-blue-600 px-3 py-1 text-sm text-white"
												: "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										}
									>
										自定义
									</button>
								</div>
								{quick === "custom" ? (
									<div className="mt-3 grid gap-2 sm:grid-cols-2">
										<div>
											<div className="text-xs text-gray-500 dark:text-gray-400">开始时间</div>
											<input
												type="datetime-local"
												name="from"
												value={fromText}
												onChange={(e) => setFromText(e.target.value)}
												className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
											/>
										</div>
										<div>
											<div className="text-xs text-gray-500 dark:text-gray-400">结束时间</div>
											<input
												type="datetime-local"
												name="to"
												value={toText}
												onChange={(e) => setToText(e.target.value)}
												className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
											/>
										</div>
									</div>
								) : null}
							</div>

							<div>
								<div className="text-sm font-medium text-gray-700 dark:text-gray-200">日志级别</div>
								<select
									multiple
									name="levels"
									value={levels}
									onChange={(e) => {
										const selected = Array.from(e.target.selectedOptions)
											.map((o) => String(o.value))
											.filter((v) => v === "INFO" || v === "WARN" || v === "ERROR" || v === "DEBUG") as LogLevel[];
										setLevels(selected);
									}}
									className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
									size={4}
								>
									<option value="INFO">INFO</option>
									<option value="WARN">WARN</option>
									<option value="ERROR">ERROR</option>
									<option value="DEBUG">DEBUG</option>
								</select>
							</div>

							<div>
								<div className="text-sm font-medium text-gray-700 dark:text-gray-200">用户ID / 操作人</div>
								<div className="mt-2 grid gap-2 sm:grid-cols-2">
									<input
										value={userIdText}
										onChange={(e) => setUserIdText(e.target.value)}
										name="userId"
										placeholder="用户ID"
										className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
									/>
									<div className="relative">
										<input
											value={operatorText}
											name="operator"
											onChange={(e) => {
												setOperatorText(e.target.value);
												setOperatorIdText("");
											}}
											placeholder="操作人关键字（昵称/邮箱/ID）"
											className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
											autoComplete="off"
										/>
										<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">留空则显示全部用户</div>
										{operatorText.trim() && !operatorIdText && usersFetcher.data?.ok && usersFetcher.data.users.length ? (
											<div className="absolute z-10 mt-2 w-full overflow-hidden rounded border border-gray-200 bg-white shadow dark:border-gray-800 dark:bg-gray-900">
												<ul className="max-h-64 overflow-auto py-1 text-sm">
													{usersFetcher.data.users.map((u) => (
														<li key={u.id}>
															<button
																type="button"
																onClick={() => {
																	setOperatorIdText(String(u.id));
																	setOperatorText(u.displayName);
																}}
																className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50"
														>
																<span className="text-gray-900 dark:text-gray-100">{u.displayName}</span>
																<span className="text-xs text-gray-500 dark:text-gray-400">
																	#{u.id}
																	{u.emailMasked ? ` · ${u.emailMasked}` : ""}
																</span>
															</button>
														</li>
													))}
												</ul>
											</div>
										) : null}
									</div>
								</div>
							</div>

							<div>
								<div className="text-sm font-medium text-gray-700 dark:text-gray-200">操作类型</div>
								<select
									name="eventType"
									value={eventType}
									onChange={(e) => setEventType(e.target.value)}
									className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
								>
									<option value="">全部</option>
									{eventTypes.map((t: string) => (
										<option key={t} value={t}>
											{t}
										</option>
									))}
								</select>
							</div>

							<div>
								<div className="text-sm font-medium text-gray-700 dark:text-gray-200">关键字搜索</div>
								<div className="mt-2 grid gap-2">
									<div className="flex items-center gap-4 text-sm text-gray-700 dark:text-gray-200">
										<label className="inline-flex items-center gap-2">
											<input type="radio" checked={qMode === "partial"} onChange={() => setQMode("partial")} />
											<span>部分匹配</span>
										</label>
										<label className="inline-flex items-center gap-2">
											<input type="radio" checked={qMode === "exact"} onChange={() => setQMode("exact")} />
											<span>精确匹配</span>
										</label>
									</div>
									<input
										name="q"
										value={q}
										onChange={(e) => setQ(e.target.value)}
										placeholder="仅搜索“操作描述”"
										className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
									/>
								</div>
							</div>

							<div>
								<div className="text-sm font-medium text-gray-700 dark:text-gray-200">排序</div>
								<div className="mt-2 flex gap-2">
									<button
										type="button"
										onClick={() => setSortDir("desc")}
										className={
											sortDir === "desc"
												? "rounded bg-blue-600 px-3 py-1 text-sm text-white"
												: "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										}
									>
										时间倒序
									</button>
									<button
										type="button"
										onClick={() => setSortDir("asc")}
										className={
											sortDir === "asc"
												? "rounded bg-blue-600 px-3 py-1 text-sm text-white"
												: "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										}
									>
										时间正序
									</button>
								</div>
							</div>

							<div className="flex items-center justify-end gap-2 pt-2">
								<button
									type="button"
									onClick={resetFilters}
									className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
								>
									重置
								</button>
								<button
									type="submit"
									disabled={isLoading}
									className="rounded bg-blue-600 px-4 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
								>
									查询
								</button>
							</div>
						</form>
					</section>

					<section className="rounded-xl border border-gray-200 bg-white shadow dark:border-gray-800 dark:bg-gray-900">
						<div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
							<div className="text-sm font-semibold text-gray-900 dark:text-gray-100">日志展示</div>
							<div className="text-xs text-gray-500 dark:text-gray-400">每页固定 20 条 · 共 {totalPages} 页</div>
						</div>
						<div className="w-full overflow-auto">
							<table className="w-full min-w-[900px] table-fixed text-sm">
								<thead className="bg-gray-50 text-gray-700 dark:bg-gray-800/60 dark:text-gray-200">
									<tr>
										<th className="w-[180px] px-4 py-3 text-left font-semibold">时间戳</th>
										<th className="w-[110px] px-4 py-3 text-left font-semibold">日志级别</th>
										<th className="w-[160px] px-4 py-3 text-left font-semibold">操作人</th>
										<th className="w-[220px] px-4 py-3 text-left font-semibold">操作类型</th>
										<th className="px-4 py-3 text-left font-semibold">操作描述</th>
										<th className="w-[130px] px-4 py-3 text-left font-semibold">IP地址</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-200 dark:divide-gray-800">
									{items.length === 0 ? (
										<tr>
											<td className="px-4 py-6 text-gray-500 dark:text-gray-400" colSpan={6}>
											暂无日志
										</td>
									</tr>
									) : (
										items.map((r) => (
											<tr key={`${r.id}`} className="hover:bg-gray-50 dark:hover:bg-gray-800/40">
												<td className="px-4 py-3 text-gray-900 dark:text-gray-100">
													{new Date(r.createdAt).toLocaleString()}
												</td>
												<td className="px-4 py-3">
													<span className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${levelBadgeClass(r.level)}`}>
														{r.level}
													</span>
												</td>
												<td className="px-4 py-3 text-gray-900 dark:text-gray-100">{r.operatorDisplayName}</td>
												<td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">{r.eventType}</td>
												<td className="px-4 py-3 text-gray-900 dark:text-gray-100">{r.description}</td>
												<td className="px-4 py-3 text-gray-700 dark:text-gray-300">{r.ipMasked}</td>
											</tr>
										))
									)}
								</tbody>
							</table>
						</div>
						<div className="flex flex-col gap-3 border-t border-gray-200 px-4 py-3 dark:border-gray-800 sm:flex-row sm:items-center sm:justify-between">
							<div className="text-xs text-gray-500 dark:text-gray-400">
								第 {page} / {totalPages} 页，共 {total} 条
							</div>
							<div className="flex flex-wrap items-center gap-1">
								<Link
									to={pageHref(Math.max(1, page - 1))}
									className={
										page <= 1
											? "pointer-events-none rounded border border-gray-200 px-2 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-500"
											: "rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									}
								>
									上一页
								</Link>
								{pagination.map((p, idx) =>
									p === "…" ? (
										<span key={`ellipsis_${idx}`} className="px-2 py-1 text-sm text-gray-400 dark:text-gray-500">
											…
										</span>
									) : (
										<Link
											key={p}
											to={pageHref(p)}
											className={
												p === page
													? "rounded bg-blue-600 px-2 py-1 text-sm text-white"
													: "rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
											}
										>
											{p}
										</Link>
									),
								)}
								<Link
									to={pageHref(Math.min(totalPages, page + 1))}
									className={
										page >= totalPages
											? "pointer-events-none rounded border border-gray-200 px-2 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-500"
											: "rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									}
								>
									下一页
								</Link>
							</div>
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
