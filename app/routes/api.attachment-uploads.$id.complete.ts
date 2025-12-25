import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { execute, getDBFromContext } from "~/lib/d1.server";
import {
	attachmentLimits,
	containsEicarBytes,
	finalizeUploadToAttachment,
	getAttachmentsBucket,
	getUploadRecord,
	inspectRarArchiveBytes,
	inspectZipArchiveBytes,
	listUploadedParts,
} from "~/lib/attachments.server";

type ActionData =
	| { ok: true }
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

	const record = await getUploadRecord(context, uploadRecordId);
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

	const expectedParts = Math.ceil(record.sizeBytes / attachmentLimits.PART_SIZE_BYTES);
	const parts = await listUploadedParts(context, uploadRecordId);
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
			await finalizeUploadToAttachment({ context, uploadRecordId });
		} catch (finalizeError) {
			try {
				await bucket.delete(record.r2Key);
			} catch {
			}
			try {
				const db = getDBFromContext(context);
				await execute(db, "DELETE FROM attachment_upload_parts WHERE upload_record_id = ?", [record.id]);
				await execute(db, "DELETE FROM attachment_uploads WHERE id = ?", [record.id]);
				await execute(db, "DELETE FROM attachments WHERE r2_key = ?", [record.r2Key]);
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
					"attachment_upload_complete_ok",
					ip,
					userAgent,
					JSON.stringify({
						traceId,
						uploader: user.displayName,
						postId: record.postId,
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
		try {
			const bucket = getAttachmentsBucket(context);
			await bucket.delete(record.r2Key);
		} catch {
		}
		try {
			const db = getDBFromContext(context);
			await execute(db, "DELETE FROM attachment_upload_parts WHERE upload_record_id = ?", [record.id]);
			await execute(db, "DELETE FROM attachment_uploads WHERE id = ?", [record.id]);
			await execute(db, "DELETE FROM attachments WHERE r2_key = ?", [record.r2Key]);
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
					"attachment_upload_complete_failed",
					ip,
					userAgent,
					JSON.stringify({
						traceId,
						uploader: user.displayName,
						postId: record.postId,
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
			return json<ActionData>({ ok: false, error: traceId ? `${text}（追踪ID：${traceId}）` : text }, { status: error.status });
		}
		return json<ActionData>({ ok: false, error: traceId ? `完成上传失败（追踪ID：${traceId}）` : "完成上传失败" }, { status: 500 });
	}
}
