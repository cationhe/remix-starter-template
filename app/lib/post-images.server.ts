import type { AppLoadContext } from "@remix-run/cloudflare";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";
import {
	assertWithinSiteStorageQuota,
	containsEicarBytes,
	getAttachmentsBucket,
	getSiteTotalStorageLimitBytes,
} from "~/lib/attachments.server";
import type { AuthUser } from "~/lib/auth.server";

function getChinaDayInfo(nowMs: number) {
	const offsetMs = 8 * 60 * 60 * 1000;
	const shifted = new Date(nowMs + offsetMs);
	const year = shifted.getUTCFullYear();
	const month = shifted.getUTCMonth() + 1;
	const day = shifted.getUTCDate();
	const dayKey = year * 10000 + month * 100 + day;
	const startMs = Date.UTC(year, month - 1, day) - offsetMs;
	const endMs = Date.UTC(year, month - 1, day + 1) - offsetMs - 1;
	return { dayKey, startMs, endMs };
}

export type PostImageRecord = {
	id: number;
	postId: number | null;
	uploaderId: number;
	draftId: string | null;
	r2Key: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: number;
};

export type PostImageUploadRecord = {
	id: number;
	postId: number | null;
	uploaderId: number;
	draftId: string | null;
	r2Key: string;
	uploadId: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: number;
	expiresAt: number;
};

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 2 * 1024 * 1024;
const PART_SIZE_BYTES = 1 * 1024 * 1024;
const UPLOAD_EXPIRES_MS = 60 * 60 * 1000;
const DAILY_USER_IMAGE_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

const allowedImageExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const allowedImageMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function sanitizeFilename(name: string) {
	const base = String(name || "").trim();
	const noPath = base.replace(/[/\\]/g, "_");
	const cleaned = noPath.replace(/[\u0000-\u001f\u007f]/g, "_");
	return cleaned.slice(0, 180) || "image";
}

function getFileExtension(filename: string) {
	const clean = sanitizeFilename(filename);
	const idx = clean.lastIndexOf(".");
	if (idx <= 0 || idx === clean.length - 1) return "";
	return clean.slice(idx + 1).toLowerCase();
}

function getUploadMode(sizeBytes: number) {
	return sizeBytes >= MULTIPART_THRESHOLD_BYTES ? ("multipart" as const) : ("single" as const);
}

export function validatePostImageMeta(args: { filename: string; mimeType: string; sizeBytes: number }) {
	const size = args.sizeBytes;
	if (!Number.isFinite(size) || size < 0) return "文件大小无效";
	if (size === 0) return "缺少文件内容";
	if (size > MAX_IMAGE_SIZE_BYTES) return "单张图片大小不能超过 5MB";
	const ext = getFileExtension(args.filename);
	if (!ext) return "图片必须包含扩展名";
	if (!allowedImageExtensions.has(ext)) return "仅支持 JPG、PNG、GIF、WebP 图片";
	if (args.mimeType && !allowedImageMimeTypes.has(args.mimeType)) {
		return "仅支持 JPG、PNG、GIF、WebP 图片";
	}
	return null;
}

function inspectImageMagic(bytes: Uint8Array) {
	if (bytes.length < 12) return "图片格式无效";
	const isPng =
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a;
	if (isPng) return null;
	const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (isJpeg) return null;
	const isGif =
		bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
	if (isGif) return null;
	const isWebp =
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50;
	if (isWebp) return null;
	return "图片格式无效";
}

async function assertWithinDailyImageQuota(args: {
	context: AppLoadContext;
	request: Request;
	user: AuthUser;
	extraBytes: number;
	now?: number;
}) {
	const now = typeof args.now === "number" ? args.now : Date.now();
	if (args.user.role === "admin" || args.user.role === "superadmin" || args.user.role === "topadmin") {
		try {
			const { dayKey } = getChinaDayInfo(now);
			const db = getDBFromContext(args.context);
			await execute(
				db,
				"INSERT INTO daily_user_activity (user_id, day_key, post_count, comment_count, image_upload_bytes, last_image_upload_at, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?) ON CONFLICT(user_id, day_key) DO UPDATE SET image_upload_bytes = daily_user_activity.image_upload_bytes + excluded.image_upload_bytes, last_image_upload_at = excluded.last_image_upload_at, updated_at = excluded.updated_at",
				[args.user.id, dayKey, Math.max(0, Math.floor(args.extraBytes)), now, now, now],
			);
		} catch {
		}
		return;
	}

	const extra = Math.max(0, Math.floor(Number(args.extraBytes || 0)));
	const { dayKey, endMs } = getChinaDayInfo(now);
	const db = getDBFromContext(args.context);
	let used = 0;
	try {
		const row = await queryOne<{ bytes: number | string }>(
			db,
			"SELECT image_upload_bytes as bytes FROM daily_user_activity WHERE user_id = ? AND day_key = ?",
			[args.user.id, dayKey],
		);
		used = Number(row?.bytes ?? 0);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such table") || message.includes("no such column")) {
			throw new Response("数据库未升级：缺少图片限额相关字段", { status: 500 });
		}
		throw new Response("图片限额检查失败，请稍后重试", { status: 500 });
	}
	if (used + extra > DAILY_USER_IMAGE_UPLOAD_LIMIT_BYTES) {
		const remaining = Math.max(0, DAILY_USER_IMAGE_UPLOAD_LIMIT_BYTES - used);
		throw new Response(
			`今日图片上传额度不足（剩余 ${Math.ceil(remaining / (1024 * 1024))}MB），请明天再试`,
			{ status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((endMs + 1 - now) / 1000))) } },
		);
	}

	await execute(
		db,
		"INSERT INTO daily_user_activity (user_id, day_key, post_count, comment_count, image_upload_bytes, last_image_upload_at, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?) ON CONFLICT(user_id, day_key) DO UPDATE SET image_upload_bytes = daily_user_activity.image_upload_bytes + excluded.image_upload_bytes, last_image_upload_at = excluded.last_image_upload_at, updated_at = excluded.updated_at",
		[args.user.id, dayKey, extra, now, now, now],
	);
}

export async function cleanupExpiredPostImageUploads(context: AppLoadContext, now = Date.now()) {
	const db = getDBFromContext(context);
	const rows = await queryAll<{ id: number; r2Key: string; uploadId: string }>(
		db,
		"SELECT id as id, r2_key as r2Key, upload_id as uploadId FROM post_image_uploads WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 50",
		[now],
	);
	if (rows.length === 0) return;
	let bucket: R2Bucket | null = null;
	try {
		bucket = getAttachmentsBucket(context);
	} catch {
		bucket = null;
	}
	for (const row of rows) {
		try {
			if (bucket && row.uploadId && row.uploadId !== "single") {
				const upload = bucket.resumeMultipartUpload(row.r2Key, row.uploadId);
				await upload.abort();
			}
		} catch {
		}
		try {
			if (bucket) await bucket.delete(row.r2Key);
		} catch {
		}
		try {
			await execute(db, "DELETE FROM post_image_upload_parts WHERE upload_record_id = ?", [row.id]);
			await execute(db, "DELETE FROM post_image_uploads WHERE id = ?", [row.id]);
		} catch {
		}
	}
}

export async function createPostImageUploadRecord(args: {
	context: AppLoadContext;
	request: Request;
	user: AuthUser;
	postId: number;
	filename: string;
	mimeType: string;
	sizeBytes: number;
}) {
	const now = Date.now();
	await cleanupExpiredPostImageUploads(args.context, now);
	await assertWithinSiteStorageQuota({ context: args.context, extraBytes: args.sizeBytes, now });
	await assertWithinDailyImageQuota({
		context: args.context,
		request: args.request,
		user: args.user,
		extraBytes: args.sizeBytes,
		now,
	});

	const safeName = sanitizeFilename(args.filename);
	const key = `images/posts/${args.postId}/${crypto.randomUUID()}_${safeName}`;
	const bucket = getAttachmentsBucket(args.context);
	const expiresAt = now + UPLOAD_EXPIRES_MS;
	const mode = getUploadMode(args.sizeBytes);
	let uploadId = "single";
	if (mode === "multipart") {
		const upload = await bucket.createMultipartUpload(key, {
			httpMetadata: { contentType: args.mimeType },
			customMetadata: {
				postId: String(args.postId),
				uploaderId: String(args.user.id),
				filename: safeName,
			},
		});
		uploadId = upload.uploadId;
	}
	const db = getDBFromContext(args.context);
	await execute(
		db,
		"INSERT INTO post_image_uploads (post_id, uploader_id, draft_id, r2_key, upload_id, filename, mime_type, size_bytes, created_at, expires_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
		[args.postId, args.user.id, key, uploadId, safeName, args.mimeType, args.sizeBytes, now, expiresAt],
	);
	const record = await queryOne<PostImageUploadRecord>(
		db,
		"SELECT id as id, post_id as postId, uploader_id as uploaderId, draft_id as draftId, r2_key as r2Key, upload_id as uploadId, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt, expires_at as expiresAt FROM post_image_uploads WHERE r2_key = ?",
		[key],
	);
	if (!record) throw new Response("创建上传任务失败", { status: 500 });
	return { record, mode, partSizeBytes: mode === "multipart" ? PART_SIZE_BYTES : null };
}

export async function createDraftPostImageUploadRecord(args: {
	context: AppLoadContext;
	request: Request;
	user: AuthUser;
	draftId: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
}) {
	const now = Date.now();
	await cleanupExpiredPostImageUploads(args.context, now);
	await assertWithinSiteStorageQuota({ context: args.context, extraBytes: args.sizeBytes, now });
	await assertWithinDailyImageQuota({
		context: args.context,
		request: args.request,
		user: args.user,
		extraBytes: args.sizeBytes,
		now,
	});

	const safeName = sanitizeFilename(args.filename);
	const key = `images/drafts/${args.user.id}/${args.draftId}/${crypto.randomUUID()}_${safeName}`;
	const bucket = getAttachmentsBucket(args.context);
	const expiresAt = now + UPLOAD_EXPIRES_MS;
	const mode = getUploadMode(args.sizeBytes);
	let uploadId = "single";
	if (mode === "multipart") {
		const upload = await bucket.createMultipartUpload(key, {
			httpMetadata: { contentType: args.mimeType },
			customMetadata: {
				draftId: String(args.draftId),
				uploaderId: String(args.user.id),
				filename: safeName,
			},
		});
		uploadId = upload.uploadId;
	}
	const db = getDBFromContext(args.context);
	await execute(
		db,
		"INSERT INTO post_image_uploads (post_id, uploader_id, draft_id, r2_key, upload_id, filename, mime_type, size_bytes, created_at, expires_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[args.user.id, args.draftId, key, uploadId, safeName, args.mimeType, args.sizeBytes, now, expiresAt],
	);
	const record = await queryOne<PostImageUploadRecord>(
		db,
		"SELECT id as id, post_id as postId, uploader_id as uploaderId, draft_id as draftId, r2_key as r2Key, upload_id as uploadId, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt, expires_at as expiresAt FROM post_image_uploads WHERE r2_key = ?",
		[key],
	);
	if (!record) throw new Response("创建上传任务失败", { status: 500 });
	return { record, mode, partSizeBytes: mode === "multipart" ? PART_SIZE_BYTES : null };
}

export async function getPostImageUploadRecord(context: AppLoadContext, uploadRecordId: number) {
	const db = getDBFromContext(context);
	return queryOne<PostImageUploadRecord>(
		db,
		"SELECT id as id, post_id as postId, uploader_id as uploaderId, draft_id as draftId, r2_key as r2Key, upload_id as uploadId, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt, expires_at as expiresAt FROM post_image_uploads WHERE id = ?",
		[uploadRecordId],
	);
}

export async function listUploadedPostImageParts(context: AppLoadContext, uploadRecordId: number) {
	const db = getDBFromContext(context);
	const parts = await queryAll<{ partNumber: number; etag: string }>(
		db,
		"SELECT part_number as partNumber, etag as etag FROM post_image_upload_parts WHERE upload_record_id = ? ORDER BY part_number ASC",
		[uploadRecordId],
	);
	return parts;
}

export async function saveUploadedPostImagePart(args: {
	context: AppLoadContext;
	uploadRecordId: number;
	partNumber: number;
	etag: string;
	sizeBytes: number;
}) {
	const db = getDBFromContext(args.context);
	await execute(
		db,
		"INSERT OR REPLACE INTO post_image_upload_parts (upload_record_id, part_number, etag, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)",
		[args.uploadRecordId, args.partNumber, args.etag, Math.max(0, Math.floor(args.sizeBytes)), Date.now()],
	);
}

export async function finalizeUploadToPostImage(args: { context: AppLoadContext; uploadRecordId: number }) {
	const db = getDBFromContext(args.context);
	const record = await getPostImageUploadRecord(args.context, args.uploadRecordId);
	if (!record) throw new Response("上传任务不存在", { status: 404 });
	await execute(
		db,
		"INSERT INTO post_images (post_id, uploader_id, draft_id, r2_key, filename, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		[record.postId, record.uploaderId, record.draftId, record.r2Key, record.filename, record.mimeType, record.sizeBytes, Date.now()],
	);
	await execute(db, "DELETE FROM post_image_upload_parts WHERE upload_record_id = ?", [record.id]);
	await execute(db, "DELETE FROM post_image_uploads WHERE id = ?", [record.id]);

	const row = await queryOne<PostImageRecord>(
		db,
		"SELECT id as id, post_id as postId, uploader_id as uploaderId, draft_id as draftId, r2_key as r2Key, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt FROM post_images WHERE r2_key = ? ORDER BY id DESC LIMIT 1",
		[record.r2Key],
	);
	if (!row) throw new Response("写入图片记录失败", { status: 500 });
	return row;
}

export async function getPostImageById(context: AppLoadContext, imageId: number) {
	const db = getDBFromContext(context);
	return queryOne<PostImageRecord>(
		db,
		"SELECT id as id, post_id as postId, uploader_id as uploaderId, draft_id as draftId, r2_key as r2Key, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt FROM post_images WHERE id = ?",
		[imageId],
	);
}

export async function associateDraftImagesToPost(args: {
	context: AppLoadContext;
	uploaderId: number;
	draftId: string;
	postId: number;
}) {
	const db = getDBFromContext(args.context);
	await execute(
		db,
		"UPDATE post_images SET post_id = ? WHERE uploader_id = ? AND draft_id = ? AND post_id IS NULL",
		[args.postId, args.uploaderId, args.draftId],
	);
}

export async function listPostImagesForAdmin(context: AppLoadContext, limit = 200) {
	const db = getDBFromContext(context);
	const rows = await queryAll<
		PostImageRecord & {
			postTitle: string | null;
			uploaderName: string | null;
		}
	>(
		db,
		"SELECT i.id as id, i.post_id as postId, i.uploader_id as uploaderId, i.draft_id as draftId, i.r2_key as r2Key, i.filename as filename, i.mime_type as mimeType, i.size_bytes as sizeBytes, i.created_at as createdAt, p.title as postTitle, u.display_name as uploaderName FROM post_images i LEFT JOIN posts p ON p.id = i.post_id LEFT JOIN users u ON u.id = i.uploader_id ORDER BY i.created_at DESC, i.id DESC LIMIT ?",
		[Math.min(500, Math.max(1, Math.floor(limit)))],
	);
	return rows;
}

export async function deletePostImageById(context: AppLoadContext, imageId: number) {
	const db = getDBFromContext(context);
	const row = await getPostImageById(context, imageId);
	if (!row) return { ok: true as const, deleted: false as const };
	await execute(db, "DELETE FROM post_images WHERE id = ?", [imageId]);
	let bucket: R2Bucket | null = null;
	try {
		bucket = getAttachmentsBucket(context);
	} catch {
		bucket = null;
	}
	if (bucket) {
		try {
			await bucket.delete(row.r2Key);
		} catch {
		}
	}
	return { ok: true as const, deleted: true as const, r2Key: row.r2Key };
}

export async function removeAllPostImagesForPost(context: AppLoadContext, postId: number) {
	const db = getDBFromContext(context);
	const images = await queryAll<{ id: number; r2Key: string }>(
		db,
		"SELECT id as id, r2_key as r2Key FROM post_images WHERE post_id = ?",
		[postId],
	);
	const uploads = await queryAll<{ id: number; r2Key: string; uploadId: string }>(
		db,
		"SELECT id as id, r2_key as r2Key, upload_id as uploadId FROM post_image_uploads WHERE post_id = ?",
		[postId],
	);

	await execute(db, "DELETE FROM post_images WHERE post_id = ?", [postId]);
	await execute(
		db,
		"DELETE FROM post_image_upload_parts WHERE upload_record_id IN (SELECT id FROM post_image_uploads WHERE post_id = ?)",
		[postId],
	);
	await execute(db, "DELETE FROM post_image_uploads WHERE post_id = ?", [postId]);

	let bucket: R2Bucket | null = null;
	try {
		bucket = getAttachmentsBucket(context);
	} catch {
		bucket = null;
	}
	if (!bucket) return;

	const r2Keys = new Set<string>();
	for (const i of images) {
		if (i.r2Key) r2Keys.add(i.r2Key);
	}
	for (const u of uploads) {
		if (u.r2Key) r2Keys.add(u.r2Key);
		if (u.uploadId && u.uploadId !== "single") {
			try {
				const upload = bucket.resumeMultipartUpload(u.r2Key, u.uploadId);
				await upload.abort();
			} catch {
			}
		}
	}

	for (const key of r2Keys) {
		try {
			await bucket.delete(key);
		} catch {
		}
	}
}

export async function getPostImagesStorageUsage(context: AppLoadContext, now = Date.now()) {
	const db = getDBFromContext(context);
	const usedRow = await queryOne<{ sum: number | string | null }>(
		db,
		"SELECT COALESCE(SUM(size_bytes), 0) as sum FROM post_images",
		[],
	);
	const reservedRow = await queryOne<{ sum: number | string | null }>(
		db,
		"SELECT COALESCE(SUM(size_bytes), 0) as sum FROM post_image_uploads WHERE expires_at > ?",
		[now],
	);
	const usedBytes = Number(usedRow?.sum ?? 0);
	const reservedBytes = Number(reservedRow?.sum ?? 0);
	const limitBytes = await getSiteTotalStorageLimitBytes(context);
	const paused = usedBytes + reservedBytes >= limitBytes;
	return { usedBytes, reservedBytes, limitBytes, paused };
}

export async function putAndScanImageBytes(args: {
	context: AppLoadContext;
	record: PostImageUploadRecord;
	bytes: Uint8Array;
}) {
	const magicErr = inspectImageMagic(args.bytes);
	if (magicErr) throw new Response(magicErr, { status: 400 });
	if (containsEicarBytes(args.bytes)) throw new Response("图片内容检查未通过", { status: 400 });
	const bucket = getAttachmentsBucket(args.context);
	await bucket.put(args.record.r2Key, args.bytes, {
		httpMetadata: { contentType: args.record.mimeType },
		customMetadata: {
			postId: String(args.record.postId ?? ""),
			draftId: String(args.record.draftId ?? ""),
			uploaderId: String(args.record.uploaderId),
			filename: args.record.filename,
		},
	});
}

export const postImageLimits = {
	MAX_IMAGE_SIZE_BYTES,
	PART_SIZE_BYTES,
	DAILY_USER_IMAGE_UPLOAD_LIMIT_BYTES,
};
