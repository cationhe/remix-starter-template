import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { getDBFromContext, queryOne } from "~/lib/d1.server";
import { attachmentLimits, createCommentUploadRecord, validateAttachmentMeta } from "~/lib/attachments.server";

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
				maxFilesPerComment: number;
			};
	  }
	| { ok: false; error: string };

export async function action({ request, context, params }: ActionFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);
	const allowAnyExtension = user.role === "superadmin" || user.role === "topadmin";

	const rawId = params.id;
	const commentId = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(commentId) || commentId <= 0) {
		return json<ActionData>({ ok: false, error: "无效的评论ID" }, { status: 400 });
	}

	const db = getDBFromContext(context);
	const comment = await queryOne<{ postId: number; authorId: number }>(
		db,
		"SELECT post_id as postId, author_id as authorId FROM comments WHERE id = ? AND deleted_at IS NULL",
		[commentId],
	);
	if (!comment) {
		return json<ActionData>({ ok: false, error: "评论不存在" }, { status: 404 });
	}
	if (comment.authorId !== user.id) {
		return json<ActionData>({ ok: false, error: "只有评论作者可以上传附件" }, { status: 403 });
	}

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
		const { record, mode, partSizeBytes } = await createCommentUploadRecord({
			context,
			postId: comment.postId,
			commentId,
			uploaderId: user.id,
			filename,
			mimeType,
			sizeBytes,
		});
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
				maxFilesPerComment: attachmentLimits.MAX_ATTACHMENTS_PER_COMMENT,
			},
		});
	} catch (error) {
		if (error instanceof Response) {
			return json<ActionData>({ ok: false, error: await error.text() }, { status: error.status });
		}
		return json<ActionData>({ ok: false, error: "创建上传任务失败" }, { status: 500 });
	}
}
