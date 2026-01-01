import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { getAttachmentsBucket } from "~/lib/attachments.server";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { getPostImageById } from "~/lib/post-images.server";

function parsePositiveInt(value: string | undefined) {
	const num = Number(value);
	if (!value || Number.isNaN(num) || !Number.isFinite(num) || num <= 0) return null;
	return Math.floor(num);
}

function sanitizeFilename(name: string) {
	const base = String(name || "").trim();
	const noPath = base.replace(/[/\\]/g, "_");
	const cleaned = noPath.replace(/[\u0000-\u001f\u007f]/g, "_");
	return cleaned.slice(0, 180) || "image";
}

function formatInlineContentDisposition(filename: string) {
	const safe = sanitizeFilename(filename);
	const encoded = encodeURIComponent(safe);
	return `inline; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
	const imageId = parsePositiveInt(params.id);
	if (!imageId) {
		throw new Response("无效的图片ID", { status: 400 });
	}

	const record = await getPostImageById(context, imageId);
	if (!record) {
		throw new Response("图片不存在", { status: 404 });
	}

	const isDraft = !record.postId;
	if (isDraft) {
		const user = await requireUser(request, context);
		assertNotBanned(user);
		if (user.id !== record.uploaderId) {
			throw new Response("无权查看图片", { status: 403 });
		}
	}

	const bucket = getAttachmentsBucket(context);
	const object = await bucket.get(record.r2Key);
	if (!object) {
		throw new Response("图片文件不存在", { status: 404 });
	}

	const headers = new Headers();
	headers.set("Content-Disposition", formatInlineContentDisposition(record.filename));
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Cache-Control", isDraft ? "private, max-age=0, must-revalidate" : "public, max-age=31536000, immutable");

	const contentType = object.httpMetadata?.contentType || record.mimeType || "application/octet-stream";
	headers.set("Content-Type", contentType);
	if (typeof record.sizeBytes === "number" && record.sizeBytes > 0) {
		headers.set("Content-Length", String(record.sizeBytes));
	}

	return new Response(object.body, { status: 200, headers });
}
