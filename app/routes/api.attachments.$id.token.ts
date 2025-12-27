import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, getClientIp, requireUser } from "~/lib/auth.server";
import { execute, getDBFromContext, queryOne } from "~/lib/d1.server";
import { getAttachmentById, signAttachmentDownloadToken } from "~/lib/attachments.server";
import {
	canDownloadAttachmentsInDiscussionArea,
	canViewDiscussionArea,
	isDiscussionPermissionsReady,
} from "~/lib/discussion-permissions.server";

type LoaderData =
	| { ok: true; token: string; expiresAt: number }
	| { ok: false; error: string };

function parsePositiveInt(value: string | undefined) {
	const num = Number(value);
	if (!value || Number.isNaN(num) || !Number.isFinite(num) || num <= 0) return null;
	return Math.floor(num);
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);

	const attachmentId = parsePositiveInt(params.id);
	if (!attachmentId) {
		return json<LoaderData>({ ok: false, error: "无效的附件ID" }, { status: 400 });
	}
	const record = await getAttachmentById(context, attachmentId);
	if (!record) {
		return json<LoaderData>({ ok: false, error: "附件不存在" }, { status: 404 });
	}
	if (!record.isDownloadable) {
		return json<LoaderData>({ ok: false, error: "该附件已被禁止下载" }, { status: 403 });
	}
	const db = getDBFromContext(context);
	const post = await queryOne<{ isBanned: number; areaId: number }>(
		db,
		"SELECT is_banned as isBanned, area_id as areaId FROM posts WHERE id = ? AND deleted_at IS NULL",
		[record.postId],
	);
	if (!post) {
		return json<LoaderData>({ ok: false, error: "帖子不存在" }, { status: 404 });
	}
	if (post.isBanned) {
		return json<LoaderData>({ ok: false, error: "该帖子已被封禁，禁止下载附件" }, { status: 403 });
	}

	const permissionReady = await isDiscussionPermissionsReady(context);
	if (permissionReady) {
		const canView = await canViewDiscussionArea(context, post.areaId, user.role);
		const canDownload = await canDownloadAttachmentsInDiscussionArea(context, post.areaId, user.role);
		if (!canView || !canDownload) {
			const ip = getClientIp(request);
			const userAgent = request.headers.get("User-Agent");
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						user.id,
						"discussion_area_attachment_download_denied",
						ip,
						userAgent,
						JSON.stringify({ areaId: post.areaId, postId: record.postId, attachmentId, role: user.role }),
						Date.now(),
					],
				);
			} catch {
			}
			return json<LoaderData>({ ok: false, error: "当前讨论区禁止下载附件" }, { status: 403 });
		}
	}

	const expiresAt = Date.now() + 5 * 60 * 1000;
	const token = await signAttachmentDownloadToken({
		context,
		attachmentId,
		userId: user.id,
		expiresAt,
	});
	return json<LoaderData>({ ok: true, token, expiresAt });
}
