import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { getAttachmentById, signAttachmentDownloadToken } from "~/lib/attachments.server";

type LoaderData =
	| { ok: true; token: string; expiresAt: number }
	| { ok: false; error: string };

function parsePositiveInt(value: string | undefined) {
	const num = Number(value);
	if (!value || Number.isNaN(num) || !Number.isFinite(num) || num <= 0) return null;
	return Math.floor(num);
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);

	const attachmentId = parsePositiveInt(params.id);
	if (!attachmentId) {
		return json<LoaderData>({ ok: false, error: "无效的附件ID" }, { status: 400 });
	}
	const record = await getAttachmentById(context, attachmentId);
	if (!record) {
		return json<LoaderData>({ ok: false, error: "附件不存在" }, { status: 404 });
	}

	const expiresAt = Date.now() + 5 * 60 * 1000;
	const token = await signAttachmentDownloadToken({
		context,
		attachmentId,
		userId: user.id,
		expiresAt,
	});
	return json<LoaderData>({ ok: true, token, expiresAt });
}

