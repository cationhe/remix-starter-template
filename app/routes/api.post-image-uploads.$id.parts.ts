import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { getPostImageUploadRecord, listUploadedPostImageParts } from "~/lib/post-images.server";

type LoaderData =
	| { ok: true; parts: number[] }
	| {
			ok: false;
			error: string;
	  };

function parseId(value: string | undefined) {
	const id = Number(value);
	if (!value || Number.isNaN(id) || !Number.isFinite(id) || id <= 0) return null;
	return Math.floor(id);
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);

	const uploadRecordId = parseId(params.id);
	if (!uploadRecordId) {
		return json<LoaderData>({ ok: false, error: "无效的上传任务ID" }, { status: 400 });
	}
	const record = await getPostImageUploadRecord(context, uploadRecordId);
	if (!record) {
		return json<LoaderData>({ ok: false, error: "上传任务不存在" }, { status: 404 });
	}
	if (record.uploaderId !== user.id) {
		return json<LoaderData>({ ok: false, error: "无权操作该上传任务" }, { status: 403 });
	}
	if (record.expiresAt <= Date.now()) {
		return json<LoaderData>({ ok: false, error: "上传任务已过期" }, { status: 410 });
	}
	if (record.uploadId === "single") {
		return json<LoaderData>({ ok: true, parts: [] });
	}

	const parts = await listUploadedPostImageParts(context, uploadRecordId);
	return json<LoaderData>({ ok: true, parts: parts.map((p) => p.partNumber) });
}

