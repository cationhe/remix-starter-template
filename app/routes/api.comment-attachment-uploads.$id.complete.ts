import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { execute, getDBFromContext, queryOne } from "~/lib/d1.server";
import {
	attachmentLimits,
	containsEicarBytes,
	finalizeUploadToCommentAttachment,
	getAttachmentsBucket,
	getCommentUploadRecord,
	inspectRarArchiveBytes,
	inspectZipArchiveBytes,
	listUploadedCommentParts,
} from "~/lib/attachments.server";

type ActionData =
	| { ok: true }
	| {
			ok: false;
			error: string;
		};

function formatSafeErrorMessage(message: string) {
	const clean = String(message || "").replace(/[\r\n\t]+/g, " ").trim();
	return clean.slice(0, 200) || "完成上传失败";
}

function parsePositiveInt(value: string | undefined) {
	const num = Number(value);
	if (!value || Number.isNaN(num) || !Number.isFinite(num) || num <= 0) return null;
	return Math.floor(num);
}

export async function action({ request, context, params }: ActionFunctionArgs) {
	if (request.method.toUpperCase() !== "POST") {
		return json<ActionData>({ ok: false, error: "不支持的请求方法" }, { status: 405 });
	}

	const user = await requireUser(request, context);
	assertNotBanned(user);
	const traceId = request.headers.get("cf-ray") || "";
	const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || null;
	const userAgent = request.headers.get("User-Agent") || null;

	const uploadRecordId = parsePositiveInt(params.id);
	if (!uploadRecordId) {
		return json<ActionData>({ ok: false, error: "无效的上传任务ID" }, { status: 400 });
	}

	const record = await getCommentUploadRecord(context, uploadRecordId);
	if (!record) {
		return json<ActionData>({ ok: false, error: "上传任务不存在" }, { status: 404 });
	}
	const post = await queryOne<{ isBanned: number }>(
		getDBFromContext(context),
		"SELECT is_banned as isBanned FROM posts WHERE id = ? AND deleted_at IS NULL",
		[record.postId],
	);
	if (!post) {
		return json<ActionData>({ ok: false, error: "帖子不存在" }, { status: 404 });
	}
	if (post.isBanned) {
		return json<ActionData>({ ok: false, error: "该帖子已被封禁，禁止上传附件" }, { status: 403 });
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

	const expectedParts = Math.ceil(record.sizeBytes / attachmentLimits.PART_SIZE_BYTES);
	const parts = await listUploadedCommentParts(context, uploadRecordId);
	if (parts.length !== expectedParts) {
		return json<ActionData>(
			{ ok: false, error: `分块数量不完整：已上传 ${parts.length} / ${expectedParts}` },
			{ status: 400 },
		);
	}
	for (let i = 0; i < expectedParts; i++) {
		if (parts[i]?.partNumber !== i + 1) {
			return json<ActionData>({ ok: false, error: "分块顺序不完整" }, { status: 400 });
		}
	}

	try {
		const bucket = getAttachmentsBucket(context);
		const upload = bucket.resumeMultipartUpload(record.r2Key, record.uploadId);
		await upload.complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
		const obj = await bucket.get(record.r2Key);
		if (!obj) {
			throw new Response("上传对象不存在", { status: 500 });
		}
		const bytes = new Uint8Array(await obj.arrayBuffer());
		if (containsEicarBytes(bytes)) {
			throw new Response("病毒扫描未通过", { status: 400 });
		}
		const idx = String(record.filename || "").lastIndexOf(".");
		const ext = idx > 0 && idx < record.filename.length - 1 ? record.filename.slice(idx + 1).toLowerCase() : "";
		if (ext === "zip") {
			const err = inspectZipArchiveBytes(bytes);
			if (err) {
				throw new Response(err, { status: 400 });
			}
		}
		if (ext === "rar") {
			const err = inspectRarArchiveBytes(bytes);
			if (err) {
				throw new Response(err, { status: 400 });
			}
		}
		try {
			await finalizeUploadToCommentAttachment({ context, uploadRecordId });
		} catch (finalizeError) {
			try {
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
			throw finalizeError;
		}
		try {
			const db = getDBFromContext(context);
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					user.id,
					"comment_attachment_upload_complete_ok",
					ip,
					userAgent,
					JSON.stringify({
						traceId,
						uploader: user.displayName,
						postId: record.postId,
						commentId: record.commentId,
						r2Key: record.r2Key,
						filename: record.filename,
						mimeType: record.mimeType,
						sizeBytes: record.sizeBytes,
					}),
					Date.now(),
				],
			);
		} catch {
		}
		return json<ActionData>({ ok: true });
	} catch (error) {
		console.error("comment_attachment_complete_failed", {
			uploadRecordId,
			commentId: record.commentId,
			r2Key: record.r2Key,
			traceId,
			error,
		});
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
		try {
			const db = getDBFromContext(context);
			const message = error instanceof Error ? error.message : "";
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					user.id,
					"comment_attachment_upload_complete_failed",
					ip,
					userAgent,
					JSON.stringify({
						traceId,
						uploader: user.displayName,
						postId: record.postId,
						commentId: record.commentId,
						r2Key: record.r2Key,
						filename: record.filename,
						mimeType: record.mimeType,
						sizeBytes: record.sizeBytes,
						message: message || (error instanceof Response ? "response_error" : "unknown_error"),
					}),
					Date.now(),
				],
			);
		} catch {
		}
		if (error instanceof Response) {
			const text = await error.text();
			const safe = formatSafeErrorMessage(text);
			return json<ActionData>(
				{ ok: false, error: traceId ? `${safe}（追踪ID：${traceId}）` : safe },
				{ status: error.status },
			);
		}
		const message = error instanceof Error ? error.message : "";
		const safe = formatSafeErrorMessage(message);
		return json<ActionData>(
			{ ok: false, error: traceId ? `${safe}（追踪ID：${traceId}）` : safe },
			{ status: 500 },
		);
	}
}
