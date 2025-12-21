import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { execute, getDBFromContext } from "~/lib/d1.server";
import {
	finalizeUploadToCommentAttachment,
	getAttachmentsBucket,
	getCommentUploadRecord,
	validateAttachmentMeta,
	wrapStreamWithEicarScan,
} from "~/lib/attachments.server";

type ActionData =
	| { ok: true }
	| {
			ok: false;
			error: string;
	  };

function parseId(value: string | undefined) {
	const id = Number(value);
	if (!value || Number.isNaN(id) || !Number.isFinite(id) || id <= 0) return null;
	return Math.floor(id);
}

export async function action({ request, context, params }: ActionFunctionArgs) {
	if (request.method.toUpperCase() !== "POST") {
		return json<ActionData>({ ok: false, error: "不支持的请求方法" }, { status: 405 });
	}

	const user = await requireUser(request, context);
	assertNotBanned(user);

	const uploadRecordId = parseId(params.id);
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
	if (record.uploadId !== "single") {
		return json<ActionData>({ ok: false, error: "该上传任务为分块模式" }, { status: 400 });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json<ActionData>({ ok: false, error: "请求格式错误" }, { status: 400 });
	}
	const file = form.get("file");
	if (!(file instanceof File)) {
		return json<ActionData>({ ok: false, error: "缺少文件" }, { status: 400 });
	}

	const metaError = validateAttachmentMeta({ filename: file.name, mimeType: file.type, sizeBytes: file.size });
	if (metaError) {
		return json<ActionData>({ ok: false, error: metaError }, { status: 400 });
	}
	if (file.size !== record.sizeBytes) {
		return json<ActionData>({ ok: false, error: "文件大小与发起上传时不一致" }, { status: 400 });
	}

	try {
		const bucket = getAttachmentsBucket(context);
		const scannedStream = wrapStreamWithEicarScan(file.stream());
		await bucket.put(record.r2Key, scannedStream, {
			httpMetadata: { contentType: record.mimeType },
			customMetadata: {
				postId: String(record.postId),
				commentId: String(record.commentId),
				uploaderId: String(record.uploaderId),
				filename: record.filename,
			},
		});
		await finalizeUploadToCommentAttachment({ context, uploadRecordId });
		return json<ActionData>({ ok: true });
	} catch (error) {
		try {
			const bucket = getAttachmentsBucket(context);
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
		const message = error instanceof Error ? error.message : "";
		if (message.includes("病毒扫描")) {
			return json<ActionData>({ ok: false, error: "病毒扫描未通过" }, { status: 400 });
		}
		if (error instanceof Response) {
			return json<ActionData>({ ok: false, error: await error.text() }, { status: error.status });
		}
		return json<ActionData>({ ok: false, error: "上传失败，请稍后重试" }, { status: 500 });
	}
}
