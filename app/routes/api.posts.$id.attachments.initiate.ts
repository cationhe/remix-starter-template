import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { execute, getDBFromContext, queryOne } from "~/lib/d1.server";
import { createUploadRecord, validateAttachmentMeta, attachmentLimits } from "~/lib/attachments.server";

type ActionData =
	| {
			ok: true;
			uploadRecordId: number;
			mode: "single" | "multipart";
			r2Key: string;
			uploadId: string;
			partSizeBytes: number | null;
			limits: {
				minSizeBytes: number;
				maxSizeBytes: number;
				maxFilesPerPost: number;
			};
	  }
	| { ok: false; error: string };

export async function action({ request, context, params }: ActionFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);
	const allowAnyExtension = user.role === "superadmin" || user.role === "topadmin";
	const bypassCountLimit = user.role === "admin" || user.role === "superadmin" || user.role === "topadmin";
	const rawId = params.id;
	const postId = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(postId)) {
		return json<ActionData>({ ok: false, error: "无效的帖子ID" }, { status: 400 });
	}
	const db = getDBFromContext(context);
	const post = await queryOne<{ authorId: number }>(
		db,
		"SELECT author_id as authorId FROM posts WHERE id = ? AND deleted_at IS NULL",
		[postId],
	);
	if (!post) {
		return json<ActionData>({ ok: false, error: "帖子不存在" }, { status: 404 });
	}
	if (post.authorId !== user.id) {
		return json<ActionData>({ ok: false, error: "只有作者可以上传附件" }, { status: 403 });
	}

	const traceId = request.headers.get("cf-ray") || "";
	const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || null;
	const userAgent = request.headers.get("User-Agent") || null;

	let body: any = null;
	try {
		body = await request.json();
	} catch {
		return json<ActionData>({ ok: false, error: "请求格式错误" }, { status: 400 });
	}
	const filename = String(body?.filename || "");
	const mimeType = String(body?.mimeType || "");
	const sizeBytes = Number(body?.sizeBytes || 0);
	const metaError = validateAttachmentMeta({ filename, mimeType, sizeBytes }, { allowAnyExtension });
	if (metaError) {
		return json<ActionData>({ ok: false, error: metaError }, { status: 400 });
	}

	try {
		const { record, mode, partSizeBytes, countLimitBypassed, existingCount, activeCount } = await createUploadRecord({
			context,
			postId,
			uploaderId: user.id,
			filename,
			mimeType,
			sizeBytes,
			bypassCountLimit,
		});
		if (countLimitBypassed) {
			try {
				await execute(
					getDBFromContext(context),
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						user.id,
						"attachment_post_count_limit_bypassed",
						ip,
						userAgent,
						JSON.stringify({
							traceId,
							postId,
							uploaderId: user.id,
							uploaderRole: user.role,
							existingCount,
							activeCount,
							limit: attachmentLimits.MAX_ATTACHMENTS_PER_POST,
						}),
						Date.now(),
					],
				);
			} catch {
			}
		}
		return json<ActionData>({
			ok: true,
			uploadRecordId: record.id,
			mode,
			r2Key: record.r2Key,
			uploadId: record.uploadId,
			partSizeBytes,
			limits: {
				minSizeBytes: attachmentLimits.MIN_FILE_SIZE_BYTES,
				maxSizeBytes: attachmentLimits.MAX_FILE_SIZE_BYTES,
				maxFilesPerPost: attachmentLimits.MAX_ATTACHMENTS_PER_POST,
			},
		});
	} catch (error) {
		if (error instanceof Response) {
			return json<ActionData>({ ok: false, error: await error.text() }, { status: error.status });
		}
		return json<ActionData>({ ok: false, error: "创建上传任务失败" }, { status: 500 });
	}
}
