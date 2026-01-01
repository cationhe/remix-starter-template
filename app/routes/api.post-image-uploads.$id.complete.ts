import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { getAttachmentsBucket } from "~/lib/attachments.server";
import {
	finalizeUploadToPostImage,
	getPostImageUploadRecord,
	listUploadedPostImageParts,
	postImageLimits,
} from "~/lib/post-images.server";

type ActionData =
	| { ok: true; imageId: number; url: string }
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

	try {
		const parts = await listUploadedPostImageParts(context, uploadRecordId);
		const partSizeBytes = postImageLimits.PART_SIZE_BYTES;
		const totalParts = Math.ceil(record.sizeBytes / partSizeBytes);
		if (parts.length !== totalParts) {
			return json<ActionData>({ ok: false, error: "缺少分块，无法完成上传" }, { status: 400 });
		}
		const sorted = parts
			.slice()
			.sort((a, b) => a.partNumber - b.partNumber)
			.map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
		for (let i = 0; i < sorted.length; i++) {
			if (sorted[i].partNumber !== i + 1 || !sorted[i].etag) {
				return json<ActionData>({ ok: false, error: "分块信息不完整" }, { status: 400 });
			}
		}
		const bucket = getAttachmentsBucket(context);
		const upload = bucket.resumeMultipartUpload(record.r2Key, record.uploadId);
		await upload.complete(sorted);
		const row = await finalizeUploadToPostImage({ context, uploadRecordId });
		return json<ActionData>({ ok: true, imageId: row.id, url: `/post-images/${row.id}` });
	} catch (error) {
		try {
			const bucket = getAttachmentsBucket(context);
			const upload = bucket.resumeMultipartUpload(record.r2Key, record.uploadId);
			await upload.abort();
		} catch {
		}
		if (error instanceof Response) {
			return json<ActionData>({ ok: false, error: await error.text() }, { status: error.status });
		}
		return json<ActionData>({ ok: false, error: "完成上传失败" }, { status: 500 });
	}
}
