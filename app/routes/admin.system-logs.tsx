import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
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
	initial: {
		items: LogRow[];
		nextCursor: string | null;
	};
};

type DataResponse = {
	ok: true;
	items: LogRow[];
	nextCursor: string | null;
};

function parseIntOrNull(value: string | null) {
	if (!value) return null;
	const n = Number(String(value).trim());
	if (!Number.isFinite(n)) return null;
	return Math.trunc(n);
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

function encodeCursor(value: { createdAt: number; id: number } | null) {
	if (!value) return null;
	try {
		return btoa(JSON.stringify(value));
	} catch {
		return null;
	}
}

function decodeCursor(value: string | null) {
	if (!value) return null;
	try {
		const parsed = JSON.parse(atob(value)) as any;
		const createdAt = Number(parsed?.createdAt ?? 0);
		const id = Number(parsed?.id ?? 0);
		if (!Number.isFinite(createdAt) || !Number.isFinite(id) || createdAt <= 0 || id <= 0) return null;
		return { createdAt, id };
	} catch {
		return null;
	}
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

function buildLogQuery(args: {
	fromMs: number;
	toMs: number;
	levels: LogLevel[];
	operatorText: string;
	userId: number | null;
	eventType: string;
	keyword: string;
	limit: number;
	sortDir: "asc" | "desc";
	cursor: { createdAt: number; id: number } | null;
}) {
	const where: string[] = [];
	const params: unknown[] = [];

	where.push("createdAt >= ? AND createdAt <= ?");
	params.push(args.fromMs);
	params.push(args.toMs);

	if (args.userId !== null) {
		where.push("userId = ?");
		params.push(args.userId);
	}
	if (args.eventType) {
		where.push("eventType = ?");
		params.push(args.eventType);
	}
	if (args.operatorText) {
		where.push("(operatorDisplayName LIKE ? OR operatorEmail LIKE ?)");
		const like = `%${args.operatorText}%`;
		params.push(like);
		params.push(like);
	}
	if (args.keyword) {
		where.push("(eventType LIKE ? OR metadataJson LIKE ?)");
		const like = `%${args.keyword}%`;
		params.push(like);
		params.push(like);
	}
	if (args.levels.length > 0) {
		where.push(`level IN (${args.levels.map(() => "?").join(",")})`);
		params.push(...args.levels);
	}

	if (args.cursor) {
		if (args.sortDir === "desc") {
			where.push("(createdAt < ? OR (createdAt = ? AND id < ?))");
			params.push(args.cursor.createdAt);
			params.push(args.cursor.createdAt);
			params.push(args.cursor.id);
		} else {
			where.push("(createdAt > ? OR (createdAt = ? AND id > ?))");
			params.push(args.cursor.createdAt);
			params.push(args.cursor.createdAt);
			params.push(args.cursor.id);
		}
	}

	const orderBy = args.sortDir === "asc" ? "createdAt ASC, id ASC" : "createdAt DESC, id DESC";

	const sql = `
		SELECT id, createdAt, level, userId, operatorDisplayName, operatorEmail, eventType, ip, metadataJson
		FROM (
			SELECT
				l.id as id,
				l.created_at as createdAt,
				l.user_id as userId,
				u.display_name as operatorDisplayName,
				u.email as operatorEmail,
				l.event_type as eventType,
				l.ip as ip,
				l.metadata_json as metadataJson,
				CASE
					WHEN LOWER(l.event_type) LIKE '%debug%' THEN 'DEBUG'
					WHEN LOWER(l.event_type) LIKE '%_failed' OR LOWER(l.event_type) LIKE '%error%' OR LOWER(l.event_type) LIKE '%exception%' THEN 'ERROR'
					WHEN LOWER(l.event_type) LIKE '%_denied' OR LOWER(l.event_type) LIKE '%rate_limited%' OR LOWER(l.event_type) LIKE '%locked%' OR LOWER(l.event_type) LIKE '%warning%' THEN 'WARN'
					ELSE 'INFO'
				END as level
			FROM security_audit_logs l
			LEFT JOIN users u ON u.id = l.user_id
		)
		WHERE ${where.join(" AND ")}
		ORDER BY ${orderBy}
		LIMIT ?
	`;
	params.push(args.limit);
	return { sql, params };
}

async function queryLogs(args: {
	context: LoaderFunctionArgs["context"];
	fromMs: number;
	toMs: number;
	levels: LogLevel[];
	operatorText: string;
	userId: number | null;
	eventType: string;
	keyword: string;
	limit: number;
	sortDir: "asc" | "desc";
	cursor: { createdAt: number; id: number } | null;
}) {
	const db = getDBFromContext(args.context);
	const { sql, params } = buildLogQuery({
		fromMs: args.fromMs,
		toMs: args.toMs,
		levels: args.levels,
		operatorText: args.operatorText,
		userId: args.userId,
		eventType: args.eventType,
		keyword: args.keyword,
		limit: args.limit,
		sortDir: args.sortDir,
		cursor: args.cursor,
	});
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
	}>(db, sql, params);

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

	const last = items.length > 0 ? items[items.length - 1] : null;
	const nextCursor = items.length >= args.limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;
	return { items, nextCursor };
}

function buildQueryString(args: {
	fromMs: number;
	toMs: number;
	levels: LogLevel[];
	operatorText: string;
	userId: number | null;
	eventType: string;
	keyword: string;
	sortDir: "asc" | "desc";
	cursor?: string | null;
	data?: boolean;
	limit?: number;
}) {
	const sp = new URLSearchParams();
	sp.set("from", String(args.fromMs));
	sp.set("to", String(args.toMs));
	if (args.levels.length > 0) sp.set("levels", args.levels.join(","));
	if (args.operatorText) sp.set("operator", args.operatorText);
	if (args.userId !== null) sp.set("userId", String(args.userId));
	if (args.eventType) sp.set("eventType", args.eventType);
	if (args.keyword) sp.set("q", args.keyword);
	sp.set("sortDir", args.sortDir);
	sp.set("limit", String(args.limit ?? 20));
	if (args.cursor) sp.set("cursor", args.cursor);
	if (args.data) sp.set("data", "1");
	return sp.toString();
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
	const now = Date.now();
	const quick = String(url.searchParams.get("quick") || "").trim();
	let fromMs = parseIntOrNull(url.searchParams.get("from"));
	let toMs = parseIntOrNull(url.searchParams.get("to"));

	if (!fromMs || !toMs) {
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
	fromMs = clamp(fromMs, 0, now);
	toMs = clamp(toMs, 0, now);
	if (fromMs > toMs) {
		const tmp = fromMs;
		fromMs = toMs;
		toMs = tmp;
	}

	const levels = normalizeLevelsParam(url.searchParams.get("levels"));
	const operatorText = String(url.searchParams.get("operator") || "").trim().slice(0, 80);
	const userIdRaw = parseIntOrNull(url.searchParams.get("userId"));
	const userId = userIdRaw !== null && userIdRaw >= 0 ? userIdRaw : null;
	const eventType = String(url.searchParams.get("eventType") || "").trim().slice(0, 120);
	const keyword = String(url.searchParams.get("q") || "").trim().slice(0, 120);
	const sortDir = String(url.searchParams.get("sortDir") || "desc") === "asc" ? "asc" : "desc";
	const limit = clamp(parseIntOrNull(url.searchParams.get("limit")) ?? 20, 1, 200);
	const cursor = decodeCursor(url.searchParams.get("cursor"));

	const wantData = url.searchParams.get("data") === "1";
	const exportMode = String(url.searchParams.get("export") || "").trim();

	const eventTypes = await getEventTypesWithCache(context, me.id);

	const doQuery = async () => {
		return await queryLogs({
			context,
			fromMs,
			toMs,
			levels,
			operatorText,
			userId,
			eventType,
			keyword,
			limit,
			sortDir,
			cursor,
		});
	};

	if (exportMode === "csv" || exportMode === "excel") {
		const result = await doQuery();
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

	if (wantData) {
		const cache = await getDefaultCache();
		const cacheUrl = new URL(request.url);
		cacheUrl.searchParams.set("uid", String(me.id));
		const cacheKey = new Request(cacheUrl.toString());
		const cached = await cache.match(cacheKey);
		if (cached) {
			return cached;
		}
		const result = await doQuery();
		const payload: DataResponse = { ok: true, items: result.items, nextCursor: result.nextCursor };
		const response = json(payload, {
			headers: {
				"Cache-Control": "max-age=30",
				Vary: "Cookie",
			},
		});
		await cache.put(cacheKey, response.clone());
		return response;
	}

	const initial = await doQuery();
	return json<LoaderData>({ me, eventTypes, initial });
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
	const fetcher = useFetcher<DataResponse>();
	const [quick, setQuick] = useState<"today" | "week" | "month" | "custom">("week");
	const [fromText, setFromText] = useState("");
	const [toText, setToText] = useState("");
	const [levels, setLevels] = useState<LogLevel[]>(["INFO", "WARN", "ERROR"]);
	const [userIdText, setUserIdText] = useState("");
	const [operatorText, setOperatorText] = useState("");
	const [eventType, setEventType] = useState("");
	const [keyword, setKeyword] = useState("");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

	const [items, setItems] = useState<LogRow[]>(() => data.initial.items as any);
	const [nextCursor, setNextCursor] = useState<string | null>(() => (data.initial.nextCursor as any) ?? null);
	const loadingMoreRef = useRef(false);
	const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

	const limit = 20;

	useEffect(() => {
		if (fetcher.data?.ok) {
			setItems(fetcher.data.items as any);
			setNextCursor(fetcher.data.nextCursor ?? null);
		}
	}, [fetcher.data]);

	const isLoading = fetcher.state !== "idle";

	const resolvedTime = useMemo(() => {
		const now = Date.now();
		if (quick === "today") {
			return { fromMs: startOfTodayMs(now), toMs: now };
		}
		if (quick === "month") {
			return { fromMs: startOfMonthMs(now), toMs: now };
		}
		if (quick === "custom") {
			const from = fromText ? Date.parse(fromText) : NaN;
			const to = toText ? Date.parse(toText) : NaN;
			if (Number.isFinite(from) && Number.isFinite(to)) {
				return { fromMs: Math.min(from, to), toMs: Math.max(from, to) };
			}
			return { fromMs: startOfWeekMs(now), toMs: now };
		}
		return { fromMs: startOfWeekMs(now), toMs: now };
	}, [quick, fromText, toText]);

	const currentQueryString = useMemo(() => {
		const userId = (() => {
			const n = Number(userIdText.trim());
			return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
		})();
		return buildQueryString({
			fromMs: resolvedTime.fromMs,
			toMs: resolvedTime.toMs,
			levels,
			operatorText,
			userId,
			eventType,
			keyword,
			sortDir,
			data: true,
			limit,
		});
	}, [resolvedTime, levels, operatorText, userIdText, eventType, keyword, sortDir]);

	const exportCsvHref = useMemo(() => {
		const sp = new URLSearchParams(currentQueryString);
		sp.delete("data");
		sp.delete("cursor");
		sp.set("export", "csv");
		return `/admin/system-logs?${sp.toString()}`;
	}, [currentQueryString]);

	const exportExcelHref = useMemo(() => {
		const sp = new URLSearchParams(currentQueryString);
		sp.delete("data");
		sp.delete("cursor");
		sp.set("export", "excel");
		return `/admin/system-logs?${sp.toString()}`;
	}, [currentQueryString]);

	function runQuery() {
		loadingMoreRef.current = false;
		fetcher.load(`/admin/system-logs?${currentQueryString}`);
	}

	function resetFilters() {
		setQuick("week");
		setFromText("");
		setToText("");
		setLevels(["INFO", "WARN", "ERROR"]);
		setUserIdText("");
		setOperatorText("");
		setEventType("");
		setKeyword("");
		setSortDir("desc");
	}

	async function loadMore() {
		if (!nextCursor) return;
		if (isLoading) return;
		if (loadingMoreRef.current) return;
		loadingMoreRef.current = true;
		const sp = new URLSearchParams(currentQueryString);
		sp.set("cursor", nextCursor);
		const res = await fetch(`/admin/system-logs?${sp.toString()}`);
		const payload = (await res.json()) as DataResponse;
		if (payload.ok) {
			setItems((prev) => [...prev, ...(payload.items as any)]);
			setNextCursor(payload.nextCursor ?? null);
		}
		loadingMoreRef.current = false;
	}

	useEffect(() => {
		const el = loadMoreSentinelRef.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						void loadMore();
					}
				}
			},
			{ root: null, rootMargin: "600px", threshold: 0.01 },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [currentQueryString, nextCursor, isLoading]);

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
						<div className="mt-4 grid gap-4">
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
												value={fromText}
												onChange={(e) => setFromText(e.target.value)}
												className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
											/>
										</div>
										<div>
											<div className="text-xs text-gray-500 dark:text-gray-400">结束时间</div>
											<input
												type="datetime-local"
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
										placeholder="用户ID"
										className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
									/>
									<input
										value={operatorText}
										onChange={(e) => setOperatorText(e.target.value)}
										placeholder="操作人关键字（姓名/邮箱）"
										className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
									/>
								</div>
							</div>

							<div>
								<div className="text-sm font-medium text-gray-700 dark:text-gray-200">操作类型</div>
								<select
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
								<input
									value={keyword}
									onChange={(e) => setKeyword(e.target.value)}
									placeholder="支持模糊匹配（事件类型/元信息）"
									className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
								/>
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
									type="button"
									onClick={runQuery}
									disabled={isLoading}
									className="rounded bg-blue-600 px-4 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
								>
									查询
								</button>
							</div>
						</div>
					</section>

					<section className="rounded-xl border border-gray-200 bg-white shadow dark:border-gray-800 dark:bg-gray-900">
						<div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
							<div className="text-sm font-semibold text-gray-900 dark:text-gray-100">日志展示</div>
							<div className="text-xs text-gray-500 dark:text-gray-400">默认每页 20 条，自动滚动加载</div>
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
						<div className="flex items-center justify-between border-t border-gray-200 px-4 py-3 dark:border-gray-800">
							<div className="text-xs text-gray-500 dark:text-gray-400">已展示 {items.length} 条</div>
							<button
								type="button"
								onClick={() => void loadMore()}
								disabled={!nextCursor || isLoading}
								className={
									nextCursor
										? "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-70 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										: "pointer-events-none rounded border border-gray-200 px-3 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-500"
								}
							>
								{nextCursor ? "加载更多" : "没有更多了"}
							</button>
						</div>
						<div ref={loadMoreSentinelRef} />
					</section>
				</div>
			</div>
		</div>
	);
}
