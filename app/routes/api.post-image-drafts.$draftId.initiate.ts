import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { createDraftPostImageUploadRecord, postImageLimits, validatePostImageMeta } from "~/lib/post-images.server";

type ActionData =
	| {
			ok: true;
			uploadRecordId: number;
			mode: "single" | "multipart";
			uploadId: string;
			partSizeBytes: number | null;
			limits: {
				maxImageSizeBytes: number;
				dailyUserImageUploadLimitBytes: number;
			};
	  }
	| {
			ok: false;
			error: string;
	  };

function parseDraftId(value: string | undefined) {
	const raw = String(value || "").trim();
	if (!raw) return null;
	if (raw.length > 120) return null;
	if (!/^[a-zA-Z0-9_-]+$/.test(raw)) return null;
	return raw;
}

export async function action({ request, context, params }: ActionFunctionArgs) {
	if (request.method.toUpperCase() !== "POST") {
		return json<ActionData>({ ok: false, error: "不支持的请求方法" }, { status: 405 });
	}

	const user = await requireUser(request, context);
	assertNotBanned(user);

	const draftId = parseDraftId(params.draftId);
	if (!draftId) {
		return json<ActionData>({ ok: false, error: "无效的草稿ID" }, { status: 400 });
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
	const metaError = validatePostImageMeta({ filename, mimeType, sizeBytes });
	if (metaError) {
		return json<ActionData>({ ok: false, error: metaError }, { status: 400 });
	}

	try {
		const { record, mode, partSizeBytes } = await createDraftPostImageUploadRecord({
			context,
			request,
			user,
			draftId,
			filename,
			mimeType,
			sizeBytes,
		});
		return json<ActionData>({
			ok: true,
			uploadRecordId: record.id,
			mode,
			uploadId: record.uploadId,
			partSizeBytes,
			limits: {
				maxImageSizeBytes: postImageLimits.MAX_IMAGE_SIZE_BYTES,
				dailyUserImageUploadLimitBytes: postImageLimits.DAILY_USER_IMAGE_UPLOAD_LIMIT_BYTES,
			},
		});
	} catch (error) {
		if (error instanceof Response) {
			return json<ActionData>({ ok: false, error: await error.text() }, { status: error.status });
		}
		return json<ActionData>({ ok: false, error: "创建上传任务失败" }, { status: 500 });
	}
}
