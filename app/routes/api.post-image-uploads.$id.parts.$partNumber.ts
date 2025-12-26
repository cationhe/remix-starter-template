import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { containsEicarBytes, getAttachmentsBucket } from "~/lib/attachments.server";
import { getPostImageUploadRecord, saveUploadedPostImagePart } from "~/lib/post-images.server";

type ActionData =
	| { ok: true; etag: string }
	| {
			ok: false;
			error: string;
	  };

function parseId(value: string | undefined) {
	const id = Number(value);
	if (!value || Number.isNaN(id) || !Number.isFinite(id) || id <= 0) return null;
	return Math.floor(id);
}

function inspectImageMagic(bytes: Uint8Array) {
	if (bytes.length < 12) return "图片格式无效";
	const isPng =
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a;
	if (isPng) return null;
	const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (isJpeg) return null;
	const isGif =
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61;
	if (isGif) return null;
	const isWebp =
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50;
	if (isWebp) return null;
	return "图片格式无效";
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
	const partNumber = parseId(params.partNumber);
	if (!partNumber) {
		return json<ActionData>({ ok: false, error: "无效的分块编号" }, { status: 400 });
	}

	const record = await getPostImageUploadRecord(context, uploadRecordId);
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

	let body: ArrayBuffer;
	try {
		body = await request.arrayBuffer();
	} catch {
		return json<ActionData>({ ok: false, error: "请求格式错误" }, { status: 400 });
	}
	const bytes = new Uint8Array(body);
	if (bytes.length === 0) {
		return json<ActionData>({ ok: false, error: "缺少分块内容" }, { status: 400 });
	}
	if (partNumber === 1) {
		const magicErr = inspectImageMagic(bytes);
		if (magicErr) {
			return json<ActionData>({ ok: false, error: magicErr }, { status: 400 });
		}
	}
	if (containsEicarBytes(bytes)) {
		return json<ActionData>({ ok: false, error: "图片内容检查未通过" }, { status: 400 });
	}

	try {
		const bucket = getAttachmentsBucket(context);
		const upload = bucket.resumeMultipartUpload(record.r2Key, record.uploadId);
		const res = await upload.uploadPart(partNumber, bytes);
		await saveUploadedPostImagePart({
			context,
			uploadRecordId,
			partNumber,
			etag: res.etag,
			sizeBytes: bytes.length,
		});
		return json<ActionData>({ ok: true, etag: res.etag });
	} catch (error) {
		if (error instanceof Response) {
			return json<ActionData>({ ok: false, error: await error.text() }, { status: error.status });
		}
		return json<ActionData>({ ok: false, error: "上传分块失败" }, { status: 500 });
	}
}

