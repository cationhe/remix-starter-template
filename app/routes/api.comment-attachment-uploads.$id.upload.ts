import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser, getClientIp } from "~/lib/auth.server";
import { execute, getDBFromContext } from "~/lib/d1.server";
import {
	containsEicarBytes,
	finalizeUploadToCommentAttachment,
	getAttachmentsBucket,
	getCommentUploadRecord,
	assertArchiveContentsSafe,
	validateAttachmentMeta,
} from "~/lib/attachments.server";

type ActionData =
	| { ok: true }
	| {
			ok: false;
			error: string;
	  };

function formatSafeErrorMessage(message: string) {
	const clean = String(message || "").replace(/[\r\n\t]+/g, " ").trim();
	return clean.slice(0, 200) || "上传失败";
}

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
	const isSuperadminUser = user.role === "superadmin" || user.role === "topadmin";

	const uploadRecordId = parseId(params.id);
	if (!uploadRecordId) {
		return json<ActionData>({ ok: false, error: "无效的上传任务ID" }, { status: 400 });
	}

	const record = await getCommentUploadRecord(context, uploadRecordId);
	if (!record) {
		return json<ActionData>({ ok: false, error: "上传任务不存在" }, { status: 404 });
	}
	if (record.uploaderId !== user.id) {
		return json<ActionData>({ ok: false, error: "无权操作该上传任务" }, { status: 403 });
	}
	if (record.expiresAt <= Date.now()) {
		return json<ActionData>({ ok: false, error: "上传任务已过期" }, { status: 410 });
	}
	if (record.uploadId !== "single") {
		return json<ActionData>({ ok: false, error: "该上传任务为分块模式" }, { status: 400 });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json<ActionData>({ ok: false, error: "请求格式错误" }, { status: 400 });
	}
	const file = form.get("file");
	if (!(file instanceof File)) {
		return json<ActionData>({ ok: false, error: "缺少文件" }, { status: 400 });
	}

	const metaError = validateAttachmentMeta(
		{ filename: file.name, mimeType: file.type, sizeBytes: file.size },
		{ isSuperadmin: isSuperadminUser },
	);
	if (metaError) {
		return json<ActionData>({ ok: false, error: metaError }, { status: 400 });
	}
	if (file.size !== record.sizeBytes) {
		return json<ActionData>({ ok: false, error: "文件大小与发起上传时不一致" }, { status: 400 });
	}

	try {
		const bucket = getAttachmentsBucket(context);
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (containsEicarBytes(bytes)) {
			throw new Error("病毒扫描未通过");
		}
		{
			const extIdx = file.name.lastIndexOf(".");
			const ext = extIdx > 0 && extIdx < file.name.length - 1 ? file.name.slice(extIdx + 1).toLowerCase() : "";
			if (ext === "zip" || ext === "rar") {
				const unsafe = assertArchiveContentsSafe(bytes, ext);
				if (unsafe) {
					return json<ActionData>({ ok: false, error: unsafe }, { status: 400 });
				}
			}
		}
		await bucket.put(record.r2Key, bytes, {
			httpMetadata: { contentType: record.mimeType },
			customMetadata: {
				postId: String(record.postId),
				commentId: String(record.commentId),
				uploaderId: String(record.uploaderId),
				filename: record.filename,
			},
		});
		await finalizeUploadToCommentAttachment({ context, uploadRecordId });
		try {
			const db = getDBFromContext(context);
			const ip = getClientIp(request);
			const ua = request.headers.get("User-Agent");
			const extIdx = file.name.lastIndexOf(".");
			const ext = extIdx > 0 && extIdx < file.name.length - 1 ? file.name.slice(extIdx + 1).toLowerCase() : "";
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					user.id,
					"comment_attachment_uploaded",
					ip,
					ua,
					JSON.stringify({
						postId: record.postId,
						commentId: record.commentId,
						r2Key: record.r2Key,
						filename: record.filename,
						ext,
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
		const traceId = request.headers.get("cf-ray") || "";
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
		console.error("comment_attachment_upload_failed", {
			uploadRecordId,
			commentId: record.commentId,
			r2Key: record.r2Key,
			traceId,
			error,
		});
		const message = error instanceof Error ? error.message : "";
		if (message.includes("病毒扫描")) {
			return json<ActionData>({ ok: false, error: traceId ? `病毒扫描未通过（追踪ID：${traceId}）` : "病毒扫描未通过" }, { status: 400 });
		}
		try {
			const db = getDBFromContext(context);
			const ip = getClientIp(request);
			const ua = request.headers.get("User-Agent");
			const extIdx = file.name.lastIndexOf(".");
			const ext = extIdx > 0 && extIdx < file.name.length - 1 ? file.name.slice(extIdx + 1).toLowerCase() : "";
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					user.id,
					"comment_attachment_upload_rejected",
					ip,
					ua,
					JSON.stringify({
						postId: record.postId,
						commentId: record.commentId,
						r2Key: record.r2Key,
						filename: record.filename,
						ext,
						mimeType: record.mimeType,
						sizeBytes: record.sizeBytes,
						message,
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
		const safe = formatSafeErrorMessage(message);
		return json<ActionData>(
			{ ok: false, error: traceId ? `${safe}（追踪ID：${traceId}）` : safe },
			{ status: 500 },
		);
	}
}
