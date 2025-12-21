import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { getCommentUploadRecord, listUploadedCommentParts } from "~/lib/attachments.server";

type LoaderData =
	| { ok: true; parts: number[] }
	| {
			ok: false;
			error: string;
	  };

export async function loader({ request, context, params }: LoaderFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);

	const rawId = params.id;
	const uploadRecordId = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(uploadRecordId) || uploadRecordId <= 0) {
		return json<LoaderData>({ ok: false, error: "无效的上传ID" }, { status: 400 });
	}
	const record = await getCommentUploadRecord(context, uploadRecordId);
	if (!record) {
		return json<LoaderData>({ ok: false, error: "上传任务不存在" }, { status: 404 });
	}
	if (record.uploaderId !== user.id) {
		return json<LoaderData>({ ok: false, error: "无权访问该上传任务" }, { status: 403 });
	}
	const parts = await listUploadedCommentParts(context, uploadRecordId);
	return json<LoaderData>({ ok: true, parts: parts.map((p) => p.partNumber) });
}
