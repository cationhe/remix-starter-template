import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, isSuperadmin, requireUser } from "~/lib/auth.server";
import { getDBFromContext, queryAll } from "~/lib/d1.server";

type AreaListItem = {
	areaId: number;
	name: string;
	isHidden: number;
};

type LoaderData = {
	areas: AreaListItem[];
};

function escapeLike(input: string) {
	return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function normalizeQuery(value: string | null) {
	return String(value ?? "")
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, 50);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (!isSuperadmin(me)) {
		throw new Response("权限不足", { status: 403 });
	}

	const url = new URL(request.url);
	const q = normalizeQuery(url.searchParams.get("q"));
	const hidden = String(url.searchParams.get("hidden") ?? "all");
	const limitRaw = Number(url.searchParams.get("limit") ?? 100);
	const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 100;

	const where: string[] = [];
	const params: Array<string | number> = [];

	if (hidden === "visible") {
		where.push("is_hidden = 0");
	} else if (hidden === "hidden") {
		where.push("is_hidden = 1");
	}

	if (q) {
		const qNum = Number(q);
		const like = `%${escapeLike(q)}%`;
		if (Number.isFinite(qNum) && qNum > 0) {
			where.push("(id = ? OR name LIKE ? ESCAPE '\\')");
			params.push(Math.floor(qNum), like);
		} else {
			where.push("name LIKE ? ESCAPE '\\'");
			params.push(like);
		}
	}

	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const db = getDBFromContext(context);
	const rows = await queryAll<AreaListItem>(
		db,
		`SELECT id as areaId, name as name, is_hidden as isHidden FROM discussion_areas ${whereSql} ORDER BY sort_order ASC, id ASC LIMIT ?`,
		[...params, limit],
	);

	return json<LoaderData>({ areas: rows });
}

