import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { execute, getDBFromContext } from "~/lib/d1.server";
import {
	attachmentLimits,
	finalizeUploadToCommentAttachment,
	getAttachmentsBucket,
	getCommentUploadRecord,
	listUploadedCommentParts,
} from "~/lib/attachments.server";

type ActionData =
	| { ok: true }
	| {
			ok: false;
			error: string;
		};

function parsePositiveInt(value: string | undefined) {
	const num = Number(value);
	if (!value || Number.isNaN(num) || !Number.isFinite(num) || num <= 0) return null;
	return Math.floor(num);
}

export async function action({ request, context, params }: ActionFunctionArgs) {
	if (request.method.toUpperCase() !== "POST") {
		return json<ActionData>({ ok: false, error: "不支持的请求方法" }, { status: 405 });
	}

	const user = await requireUser(request, context);
	assertNotBanned(user);

	const uploadRecordId = parsePositiveInt(params.id);
	if (!uploadRecordId) {
		return json<ActionData>({ ok: false, error: "无效的上传任务ID" }, { status: 400 });
	}

	const record = await getCommentUploadRecord(context, uploadRecordId);
	if (!record) {
		return json<ActionData>({ ok: false, error: "上传任务不存在" }, { status: 404 });
	}
	if (record.uploaderId !== user.id) {
		return json<ActionData>({ ok: false, error: "无权操作该上传任务" }, { status: 403 });
	}
	if (record.expiresAt <= Date.now()) {
		return json<ActionData>({ ok: false, error: "上传任务已过期" }, { status: 410 });
	}
	if (record.uploadId === "single") {
		return json<ActionData>({ ok: false, error: "该上传任务为单文件模式" }, { status: 400 });
	}

	const expectedParts = Math.ceil(record.sizeBytes / attachmentLimits.PART_SIZE_BYTES);
	const parts = await listUploadedCommentParts(context, uploadRecordId);
	if (parts.length !== expectedParts) {
		return json<ActionData>(
			{ ok: false, error: `分块数量不完整：已上传 ${parts.length} / ${expectedParts}` },
			{ status: 400 },
		);
	}
	for (let i = 0; i < expectedParts; i++) {
		if (parts[i]?.partNumber !== i + 1) {
			return json<ActionData>({ ok: false, error: "分块顺序不完整" }, { status: 400 });
		}
	}

	try {
		const bucket = getAttachmentsBucket(context);
		const upload = bucket.resumeMultipartUpload(record.r2Key, record.uploadId);
		await upload.complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
		try {
			await finalizeUploadToCommentAttachment({ context, uploadRecordId });
		} catch (finalizeError) {
			try {
				await bucket.delete(record.r2Key);
			} catch {
			}
			try {
				const db = getDBFromContext(context);
				await execute(db, "DELETE FROM comment_attachment_upload_parts WHERE upload_record_id = ?", [record.id]);
				await execute(db, "DELETE FROM comment_attachment_uploads WHERE id = ?", [record.id]);
				await execute(db, "DELETE FROM comment_attachments WHERE r2_key = ?", [record.r2Key]);
			} catch {
			}
			throw finalizeError;
		}
		return json<ActionData>({ ok: true });
	} catch (error) {
		if (error instanceof Response) {
			return json<ActionData>({ ok: false, error: await error.text() }, { status: error.status });
		}
		return json<ActionData>({ ok: false, error: "完成上传失败" }, { status: 500 });
	}
}
