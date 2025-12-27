import type { AppLoadContext } from "@remix-run/cloudflare";
import { getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";
import type { UserRole } from "~/lib/auth.server";

export type DiscussionPermissions = {
	canView: boolean;
	canPost: boolean;
	canComment: boolean;
	canDownloadAttachments: boolean;
};

type RoleInheritanceRow = {
	role: string;
	parentRole: string | null;
};

type PermissionRow = {
	areaId: number;
	role: string;
	inherit: number;
	canView: number | null;
	canPost: number | null;
	canComment: number | null;
	canDownloadAttachments: number | null;
};

const fallbackRoleParent: Record<UserRole, UserRole | null> = {
	user: null,
	admin: "user",
	superadmin: "admin",
	topadmin: "superadmin",
};

function normalizeBool(value: number | null | undefined) {
	return Boolean(value ?? 0);
}

async function getRoleChain(context: AppLoadContext, role: UserRole): Promise<UserRole[]> {
	try {
		const db = getDBFromContext(context);
		const rows = await queryAll<RoleInheritanceRow>(
			db,
			"SELECT role as role, parent_role as parentRole FROM discussion_role_inheritance",
		);
		if (rows.length === 0) {
			throw new Error("empty role inheritance");
		}
		const parentByRole = new Map<string, string | null>();
		for (const r of rows) parentByRole.set(String(r.role), r.parentRole === null ? null : String(r.parentRole));
		const chain: UserRole[] = [];
		let current: string | null = role;
		let guard = 0;
		while (current && guard < 10) {
			chain.push(current as UserRole);
			current = parentByRole.get(current) ?? null;
			guard++;
		}
		return chain;
	} catch {
		const chain: UserRole[] = [];
		let current: UserRole | null = role;
		let guard = 0;
		while (current && guard < 10) {
			chain.push(current);
			current = fallbackRoleParent[current];
			guard++;
		}
		return chain;
	}
}

function resolvePermissions(chain: UserRole[], rows: PermissionRow[]): DiscussionPermissions {
	const byRole = new Map<UserRole, PermissionRow>();
	for (const r of rows) {
		const role = r.role as UserRole;
		if (role === "user" || role === "admin" || role === "superadmin" || role === "topadmin") {
			byRole.set(role, r);
		}
	}

	let canView = false;
	let canPost = false;
	let canComment = false;
	let canDownloadAttachments = false;

	for (const role of chain) {
		const row = byRole.get(role);
		if (!row) continue;

		const inherit = Boolean(row.inherit);
		const v = row.canView;
		const p = row.canPost;
		const c = row.canComment;
		const d = row.canDownloadAttachments;

		if (!inherit) {
			canView = normalizeBool(v);
			canPost = normalizeBool(p);
			canComment = normalizeBool(c);
			canDownloadAttachments = normalizeBool(d);
			return { canView, canPost, canComment, canDownloadAttachments };
		}

		if (v !== null && v !== undefined) canView = normalizeBool(v);
		if (p !== null && p !== undefined) canPost = normalizeBool(p);
		if (c !== null && c !== undefined) canComment = normalizeBool(c);
		if (d !== null && d !== undefined) canDownloadAttachments = normalizeBool(d);
	}

	return { canView, canPost, canComment, canDownloadAttachments };
}

export async function getEffectiveDiscussionPermissionsForArea(
	context: AppLoadContext,
	areaId: number,
	role: UserRole,
): Promise<DiscussionPermissions> {
	try {
		const chain = await getRoleChain(context, role);
		const db = getDBFromContext(context);
		const placeholders = chain.map(() => "?").join(",");
		const rows = await queryAll<PermissionRow>(
			db,
			`SELECT area_id as areaId, role as role, inherit as inherit, can_view as canView, can_post as canPost, can_comment as canComment, can_download_attachments as canDownloadAttachments
			 FROM discussion_area_role_permissions
			 WHERE area_id = ?
			   AND role IN (${placeholders})`,
			[areaId, ...chain],
		);
		return resolvePermissions(chain, rows);
	} catch {
		return { canView: true, canPost: true, canComment: true, canDownloadAttachments: true };
	}
}

export async function getEffectiveDiscussionPermissionsForAreas(
	context: AppLoadContext,
	areaIds: number[],
	role: UserRole,
): Promise<Record<number, DiscussionPermissions>> {
	const out: Record<number, DiscussionPermissions> = {};
	for (const id of areaIds) {
		out[id] = { canView: true, canPost: true, canComment: true, canDownloadAttachments: true };
	}
	if (areaIds.length === 0) return out;

	try {
		const chain = await getRoleChain(context, role);
		const db = getDBFromContext(context);
		const areaPlaceholders = areaIds.map(() => "?").join(",");
		const rolePlaceholders = chain.map(() => "?").join(",");
		const rows = await queryAll<PermissionRow>(
			db,
			`SELECT area_id as areaId, role as role, inherit as inherit, can_view as canView, can_post as canPost, can_comment as canComment, can_download_attachments as canDownloadAttachments
			 FROM discussion_area_role_permissions
			 WHERE area_id IN (${areaPlaceholders})
			   AND role IN (${rolePlaceholders})`,
			[...areaIds, ...chain],
		);
		const byArea = new Map<number, PermissionRow[]>();
		for (const r of rows) {
			const list = byArea.get(r.areaId) ?? [];
			list.push(r);
			byArea.set(r.areaId, list);
		}
		for (const id of areaIds) {
			const r = byArea.get(id) ?? [];
			out[id] = resolvePermissions(chain, r);
		}
		return out;
	} catch {
		return out;
	}
}

export async function canViewDiscussionArea(context: AppLoadContext, areaId: number, role: UserRole) {
	const perm = await getEffectiveDiscussionPermissionsForArea(context, areaId, role);
	return perm.canView;
}

export async function canPostInDiscussionArea(context: AppLoadContext, areaId: number, role: UserRole) {
	const perm = await getEffectiveDiscussionPermissionsForArea(context, areaId, role);
	return perm.canPost;
}

export async function canCommentInDiscussionArea(context: AppLoadContext, areaId: number, role: UserRole) {
	const perm = await getEffectiveDiscussionPermissionsForArea(context, areaId, role);
	return perm.canComment;
}

export async function canDownloadAttachmentsInDiscussionArea(context: AppLoadContext, areaId: number, role: UserRole) {
	const perm = await getEffectiveDiscussionPermissionsForArea(context, areaId, role);
	return perm.canDownloadAttachments;
}

export async function isDiscussionPermissionsReady(context: AppLoadContext) {
	try {
		const db = getDBFromContext(context);
		const row = await queryOne<{ ok: number }>(
			db,
			"SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
			["discussion_area_role_permissions"],
		);
		return Boolean(row?.ok);
	} catch {
		return false;
	}
}

