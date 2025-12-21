import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import {
	attachmentLimits,
	containsEicarBytes,
	getAttachmentsBucket,
	getCommentUploadRecord,
	saveUploadedCommentPart,
} from "~/lib/attachments.server";

type ActionData =
	| { ok: true; etag: string }
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
	const user = await requireUser(request, context);
	assertNotBanned(user);

	const uploadRecordId = parsePositiveInt(params.id);
	const partNumber = parsePositiveInt(params.partNumber);
	if (!uploadRecordId || !partNumber) {
		return json<ActionData>({ ok: false, error: "无效的参数" }, { status: 400 });
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

	const body = await request.arrayBuffer();
	const sizeBytes = body.byteLength;
	if (sizeBytes <= 0) {
		return json<ActionData>({ ok: false, error: "分块内容为空" }, { status: 400 });
	}
	if (sizeBytes > attachmentLimits.PART_SIZE_BYTES) {
		return json<ActionData>({ ok: false, error: "分块大小超出限制" }, { status: 400 });
	}
	if (containsEicarBytes(new Uint8Array(body))) {
		return json<ActionData>({ ok: false, error: "病毒扫描未通过" }, { status: 400 });
	}

	try {
		const bucket = getAttachmentsBucket(context);
		const upload = bucket.resumeMultipartUpload(record.r2Key, record.uploadId);
		const part = await upload.uploadPart(partNumber, body);
		await saveUploadedCommentPart({ context, uploadRecordId, partNumber, etag: part.etag, sizeBytes });
		return json<ActionData>({ ok: true, etag: part.etag });
	} catch (error) {
		if (error instanceof Response) {
			return json<ActionData>({ ok: false, error: await error.text() }, { status: error.status });
		}
		return json<ActionData>({ ok: false, error: "上传分块失败" }, { status: 500 });
	}
}

