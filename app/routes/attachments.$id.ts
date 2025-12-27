import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { getDBFromContext, queryOne } from "~/lib/d1.server";
import {
	formatContentDisposition,
	getAttachmentById,
	getAttachmentsBucket,
	verifyAttachmentDownloadToken,
} from "~/lib/attachments.server";

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
		throw new Response("无效的附件ID", { status: 400 });
	}

	const url = new URL(request.url);
	const token = String(url.searchParams.get("token") || "");
	const ok = await verifyAttachmentDownloadToken({
		context,
		token,
		attachmentId,
		userId: user.id,
	});
	if (!ok) {
		throw new Response("下载链接无效或已过期", { status: 403 });
	}

	const record = await getAttachmentById(context, attachmentId);
	if (!record) {
		throw new Response("附件不存在", { status: 404 });
	}
	if (!record.isDownloadable) {
		throw new Response("该附件已被禁止下载", { status: 403 });
	}
	const db = getDBFromContext(context);
	const post = await queryOne<{ isBanned: number }>(
		db,
		"SELECT is_banned as isBanned FROM posts WHERE id = ? AND deleted_at IS NULL",
		[record.postId],
	);
	if (!post) {
		throw new Response("帖子不存在", { status: 404 });
	}
	if (post.isBanned) {
		throw new Response("该帖子已被封禁，禁止下载附件", { status: 403 });
	}

	const bucket = getAttachmentsBucket(context);
	const object = await bucket.get(record.r2Key);
	if (!object) {
		throw new Response("附件文件不存在", { status: 404 });
	}

	const headers = new Headers();
	headers.set("Content-Disposition", formatContentDisposition(record.filename));
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Cache-Control", "private, max-age=0, must-revalidate");

	const contentType = object.httpMetadata?.contentType || record.mimeType || "application/octet-stream";
	headers.set("Content-Type", contentType);
	if (typeof record.sizeBytes === "number" && record.sizeBytes > 0) {
		headers.set("Content-Length", String(record.sizeBytes));
	}

	return new Response(object.body, { status: 200, headers });
}
