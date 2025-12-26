import type { AppLoadContext } from "@remix-run/cloudflare";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";
import {
	attachmentStorageLimits,
	formatTotalStorageLimit,
	normalizeTotalStorageLimitBytes,
} from "~/lib/attachment-storage";

export type AttachmentRecord = {
	id: number;
	postId: number;
	uploaderId: number;
	r2Key: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: number;
};

export type AttachmentUploadRecord = {
	id: number;
	postId: number;
	uploaderId: number;
	r2Key: string;
	uploadId: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: number;
	expiresAt: number;
};

export type CommentAttachmentRecord = {
	id: number;
	commentId: number;
	postId: number;
	uploaderId: number;
	r2Key: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: number;
};

export type CommentAttachmentUploadRecord = {
	id: number;
	commentId: number;
	postId: number;
	uploaderId: number;
	r2Key: string;
	uploadId: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: number;
	expiresAt: number;
};

const MIN_FILE_SIZE_BYTES = 10;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_POST = 3;
const MAX_TOTAL_POST_BYTES = 500 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_COMMENT = 3;
const MAX_TOTAL_COMMENT_BYTES = 500 * 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024;
const PART_SIZE_BYTES = 5 * 1024 * 1024;
const UPLOAD_EXPIRES_MS = 60 * 60 * 1000;

export async function getSiteTotalStorageLimitBytes(context: AppLoadContext) {
	try {
		const db = getDBFromContext(context);
		const row = await queryOne<{ valueJson: string }>(
			db,
			"SELECT value_json as valueJson FROM app_settings WHERE key = ?",
			[attachmentStorageLimits.TOTAL_STORAGE_LIMIT_SETTING_KEY],
		);
		if (!row?.valueJson) {
			return attachmentStorageLimits.DEFAULT_TOTAL_STORAGE_LIMIT_BYTES;
		}
		const parsed = JSON.parse(row.valueJson) as unknown;
		const raw = typeof parsed === "number" ? parsed : Number(parsed);
		return normalizeTotalStorageLimitBytes(raw);
	} catch {
		return attachmentStorageLimits.DEFAULT_TOTAL_STORAGE_LIMIT_BYTES;
	}
}

const normalUserAllowedExtensions = new Set([
	"ino",
	"py",
	"rar",
	"zip",
	"docx",
	"doc",
	"pdf",
	"mp4",
]);

const archiveExtensions = new Set(["zip", "rar"]);

const forbiddenArchiveInnerExtensions = new Set([
	"exe",
	"dll",
	"com",
	"msi",
	"bat",
	"cmd",
	"ps1",
	"sh",
	"jar",
	"js",
	"html",
	"htm",
	"svg",
]);

const forbiddenNestedArchiveExtensions = new Set(["zip", "rar", "7z", "tar", "gz"]);

function getEnv(context: AppLoadContext): Env {
	return (context as any).cloudflare.env as Env;
}

export function getAttachmentsBucket(context: AppLoadContext): R2Bucket {
	const bucket = (getEnv(context) as any).ATTACHMENTS as R2Bucket | undefined;
	if (!bucket) {
		throw new Response("附件存储未启用：请先在 Cloudflare Dashboard 开启 R2 并绑定存储桶", { status: 503 });
	}
	return bucket;
}

function sanitizeFilename(name: string) {
	const base = String(name || "").trim();
	const noPath = base.replace(/[/\\]/g, "_");
	const cleaned = noPath.replace(/[\u0000-\u001f\u007f]/g, "_");
	return cleaned.slice(0, 180) || "file";
}

function getFileExtension(filename: string) {
	const clean = sanitizeFilename(filename);
	const idx = clean.lastIndexOf(".");
	if (idx <= 0 || idx === clean.length - 1) return "";
	return clean.slice(idx + 1).toLowerCase();
}

export function validateAttachmentMeta(
	args: { filename: string; mimeType: string; sizeBytes: number },
	options?: { bypassMaxSize?: boolean; allowAnyExtension?: boolean },
) {
	const size = args.sizeBytes;
	if (!Number.isFinite(size) || size < 0) {
		return "文件大小无效";
	}
	if (size < MIN_FILE_SIZE_BYTES) {
		return "上传文件大小不能小于10字节";
	}
	if (!options?.bypassMaxSize && size > MAX_FILE_SIZE_BYTES) {
		return "文件大小需在 10B 到 100MB 之间";
	}
	const ext = getFileExtension(args.filename);
	if (!ext) {
		return "文件必须包含扩展名";
	}
	if (!options?.allowAnyExtension && !normalUserAllowedExtensions.has(ext)) {
		return "不支持的文件类型";
	}
	return null;
}

function readUint16LE(bytes: Uint8Array, offset: number) {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number) {
	return (
		bytes[offset] |
		(bytes[offset + 1] << 8) |
		(bytes[offset + 2] << 16) |
		(bytes[offset + 3] << 24)
	) >>> 0;
}

export function inspectZipCentralDirectoryBytes(args: {
	centralDirBytes: Uint8Array;
	maxEntries: number;
	maxTotalUncompressedBytes: number;
	maxCompressionRatio: number;
}) {
	const bytes = args.centralDirBytes;
	let offset = 0;
	let entries = 0;
	let totalUncompressed = 0;

	while (offset + 46 <= bytes.length) {
		const sig = readUint32LE(bytes, offset);
		if (sig !== 0x02014b50) {
			break;
		}
		const compressedSize = readUint32LE(bytes, offset + 20);
		const uncompressedSize = readUint32LE(bytes, offset + 24);
		const nameLen = readUint16LE(bytes, offset + 28);
		const extraLen = readUint16LE(bytes, offset + 30);
		const commentLen = readUint16LE(bytes, offset + 32);
		const nameStart = offset + 46;
		const nameEnd = nameStart + nameLen;
		if (nameEnd > bytes.length) {
			return "压缩包格式无效";
		}
		const name = new TextDecoder().decode(bytes.slice(nameStart, nameEnd));
		const normalized = String(name || "").replace(/\\/g, "/");
		const trimmed = normalized.replace(/^\/+/, "");
		if (!trimmed) {
			return "压缩包内容检查未通过";
		}
		if (trimmed.includes("\u0000")) {
			return "压缩包内容检查未通过";
		}
		const parts = trimmed.split("/").filter(Boolean);
		if (parts.some((p) => p === "." || p === "..")) {
			return "压缩包内容检查未通过";
		}
		const isDir = trimmed.endsWith("/");
		if (!isDir) {
			const idx = trimmed.lastIndexOf(".");
			const innerExt = idx > 0 && idx < trimmed.length - 1 ? trimmed.slice(idx + 1).toLowerCase() : "";
			if (innerExt && forbiddenArchiveInnerExtensions.has(innerExt)) {
				return "压缩包内容检查未通过：包含不允许的文件类型";
			}
			if (innerExt && forbiddenNestedArchiveExtensions.has(innerExt)) {
				return "压缩包内容检查未通过：不允许嵌套压缩包";
			}
		}

		entries++;
		if (entries > args.maxEntries) {
			return "压缩包内容检查未通过：文件数量过多";
		}
		if (Number.isFinite(uncompressedSize)) {
			totalUncompressed += uncompressedSize;
			if (totalUncompressed > args.maxTotalUncompressedBytes) {
				return "压缩包内容检查未通过：解压后体积过大";
			}
		}
		const recordLen = 46 + nameLen + extraLen + commentLen;
		offset += recordLen;
		if (compressedSize === 0 && uncompressedSize === 0 && recordLen <= 0) {
			return "压缩包格式无效";
		}
	}

	if (entries === 0) {
		return "压缩包格式无效";
	}
	return null;
}

export async function inspectZipArchiveFile(file: File) {
	const sizeBytes = file.size;
	const tailSize = Math.min(sizeBytes, 66_000 + 22);
	const tail = new Uint8Array(await file.slice(sizeBytes - tailSize, sizeBytes).arrayBuffer());
	let eocdIndex = -1;
	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
			eocdIndex = i;
			break;
		}
	}
	if (eocdIndex < 0) {
		return "压缩包格式无效";
	}
	const cdSize = readUint32LE(tail, eocdIndex + 12);
	const cdOffset = readUint32LE(tail, eocdIndex + 16);
	if (!cdSize || cdSize > 4 * 1024 * 1024) {
		return "压缩包内容检查未通过：目录过大";
	}
	if (cdOffset + cdSize > sizeBytes) {
		return "压缩包格式无效";
	}
	const centralDirBytes = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
	const err = inspectZipCentralDirectoryBytes({
		centralDirBytes,
		maxEntries: 500,
		maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
		maxCompressionRatio: 80,
	});
	if (err) return err;
	const ratio = sizeBytes > 0 ? (2 * 1024 * 1024 * 1024) / sizeBytes : 0;
	if (ratio > 0 && ratio > 10_000) {
		return "压缩包内容检查未通过";
	}
	return null;
}

export function inspectZipArchiveBytes(bytes: Uint8Array) {
	const sizeBytes = bytes.length;
	const tailSize = Math.min(sizeBytes, 66_000 + 22);
	const tail = bytes.slice(sizeBytes - tailSize, sizeBytes);
	let eocdIndex = -1;
	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
			eocdIndex = i;
			break;
		}
	}
	if (eocdIndex < 0) {
		return "压缩包格式无效";
	}
	const cdSize = readUint32LE(tail, eocdIndex + 12);
	const cdOffset = readUint32LE(tail, eocdIndex + 16);
	if (!cdSize || cdSize > 4 * 1024 * 1024) {
		return "压缩包内容检查未通过：目录过大";
	}
	if (cdOffset + cdSize > sizeBytes) {
		return "压缩包格式无效";
	}
	const centralDirBytes = bytes.slice(cdOffset, cdOffset + cdSize);
	return inspectZipCentralDirectoryBytes({
		centralDirBytes,
		maxEntries: 500,
		maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
		maxCompressionRatio: 80,
	});
}

export async function inspectRarArchiveFile(file: File) {
	const head = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
	const sig = new TextDecoder().decode(head.slice(0, 8));
	const isRar4 = sig === "Rar!\u001a\u0007\u0000";
	const isRar5 = sig === "Rar!\u001a\u0007\u0001\u0000";
	if (!isRar4 && !isRar5) {
		return "压缩包格式无效";
	}
	const text = new TextDecoder().decode(head).toLowerCase();
	if (
		text.includes(".exe") ||
		text.includes(".dll") ||
		text.includes(".bat") ||
		text.includes(".cmd") ||
		text.includes(".ps1") ||
		text.includes(".sh") ||
		text.includes(".zip") ||
		text.includes(".rar") ||
		text.includes(".7z") ||
		text.includes(".tar") ||
		text.includes(".gz")
	) {
		return "压缩包内容检查未通过";
	}
	return null;
}

export function inspectRarArchiveBytes(bytes: Uint8Array) {
	const head = bytes.slice(0, Math.min(bytes.length, 1024 * 1024));
	const sig = new TextDecoder().decode(head.slice(0, 8));
	const isRar4 = sig === "Rar!\u001a\u0007\u0000";
	const isRar5 = sig === "Rar!\u001a\u0007\u0001\u0000";
	if (!isRar4 && !isRar5) {
		return "压缩包格式无效";
	}
	const text = new TextDecoder().decode(head).toLowerCase();
	if (
		text.includes(".exe") ||
		text.includes(".dll") ||
		text.includes(".bat") ||
		text.includes(".cmd") ||
		text.includes(".ps1") ||
		text.includes(".sh") ||
		text.includes(".zip") ||
		text.includes(".rar") ||
		text.includes(".7z") ||
		text.includes(".tar") ||
		text.includes(".gz")
	) {
		return "压缩包内容检查未通过";
	}
	return null;
}

export async function cleanupExpiredUploads(context: AppLoadContext, now = Date.now()) {
	const db = getDBFromContext(context);
	const expired = await queryAll<{ id: number; r2Key: string; uploadId: string }>(
		db,
		"SELECT id as id, r2_key as r2Key, upload_id as uploadId FROM attachment_uploads WHERE expires_at <= ? LIMIT 200",
		[now],
	);
	if (expired.length === 0) return;
	const bucket = getAttachmentsBucket(context);
	for (const item of expired) {
		try {
			if (item.uploadId && item.uploadId !== "single") {
				const upload = bucket.resumeMultipartUpload(item.r2Key, item.uploadId);
				await upload.abort();
			}
		} catch {
		}
		try {
			await bucket.delete(item.r2Key);
		} catch {
		}
		try {
			await execute(db, "DELETE FROM attachment_upload_parts WHERE upload_record_id = ?", [item.id]);
			await execute(db, "DELETE FROM attachment_uploads WHERE id = ?", [item.id]);
		} catch {
		}
	}
}

export async function countAttachmentsForPost(context: AppLoadContext, postId: number) {
	const db = getDBFromContext(context);
	const row = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM attachments WHERE post_id = ?",
		[postId],
	);
	return Number(row?.count ?? 0);
}

export async function countActiveUploadsForPost(context: AppLoadContext, postId: number, now = Date.now()) {
	const db = getDBFromContext(context);
	const row = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM attachment_uploads WHERE post_id = ? AND expires_at > ?",
		[postId, now],
	);
	return Number(row?.count ?? 0);
}

export type AttachmentStorageUsage = {
	usedBytes: number;
	reservedBytes: number;
	limitBytes: number;
	paused: boolean;
};

export async function getAttachmentStorageUsage(context: AppLoadContext, now = Date.now()): Promise<AttachmentStorageUsage> {
	const db = getDBFromContext(context);
	const usedRow = await queryOne<{ sum: number | string | null }>(
		db,
		"SELECT COALESCE((SELECT SUM(size_bytes) FROM attachments), 0) + COALESCE((SELECT SUM(size_bytes) FROM comment_attachments), 0) as sum",
		[],
	);
	const reservedRow = await queryOne<{ sum: number | string | null }>(
		db,
		"SELECT COALESCE((SELECT SUM(size_bytes) FROM attachment_uploads WHERE expires_at > ?), 0) + COALESCE((SELECT SUM(size_bytes) FROM comment_attachment_uploads WHERE expires_at > ?), 0) as sum",
		[now, now],
	);
	const usedBytes = Number(usedRow?.sum ?? 0);
	const reservedBytes = Number(reservedRow?.sum ?? 0);
	const limitBytes = await getSiteTotalStorageLimitBytes(context);
	const paused = usedBytes + reservedBytes >= limitBytes;
	return { usedBytes, reservedBytes, limitBytes, paused };
}

export async function assertWithinSiteStorageQuota(args: {
	context: AppLoadContext;
	extraBytes: number;
	now?: number;
}) {
	const now = args.now ?? Date.now();
	const extraBytes = Math.max(0, Number(args.extraBytes || 0));
	const usage = await getAttachmentStorageUsage(args.context, now);
	if (usage.usedBytes + usage.reservedBytes + extraBytes > usage.limitBytes) {
		throw new Response(
			`网站总存储量已达到上限（${formatTotalStorageLimit(usage.limitBytes)}），已暂停附件上传`,
			{ status: 400 },
		);
	}
}

export async function listAttachmentsByPostId(context: AppLoadContext, postId: number) {
	const db = getDBFromContext(context);
	const rows = await queryAll<AttachmentRecord>(
		db,
		"SELECT id as id, post_id as postId, uploader_id as uploaderId, r2_key as r2Key, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt FROM attachments WHERE post_id = ? ORDER BY created_at ASC",
		[postId],
	);
	return rows;
}

export async function listCommentAttachmentsByCommentIds(context: AppLoadContext, commentIds: number[]) {
	const ids = commentIds.map((id) => Math.floor(Number(id))).filter((id) => Number.isFinite(id) && id > 0);
	if (ids.length === 0) return [] as CommentAttachmentRecord[];
	const db = getDBFromContext(context);
	const placeholders = ids.map(() => "?").join(",");
	const rows = await queryAll<CommentAttachmentRecord>(
		db,
		`SELECT id as id, comment_id as commentId, post_id as postId, uploader_id as uploaderId, r2_key as r2Key, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt FROM comment_attachments WHERE comment_id IN (${placeholders}) ORDER BY created_at ASC`,
		ids,
	);
	return rows;
}

export async function getCommentAttachmentById(context: AppLoadContext, attachmentId: number) {
	const db = getDBFromContext(context);
	const row = await queryOne<CommentAttachmentRecord>(
		db,
		"SELECT id as id, comment_id as commentId, post_id as postId, uploader_id as uploaderId, r2_key as r2Key, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt FROM comment_attachments WHERE id = ?",
		[attachmentId],
	);
	return row;
}

export async function cleanupExpiredCommentUploads(context: AppLoadContext, now = Date.now()) {
	const db = getDBFromContext(context);
	const expired = await queryAll<{ id: number; r2Key: string; uploadId: string }>(
		db,
		"SELECT id as id, r2_key as r2Key, upload_id as uploadId FROM comment_attachment_uploads WHERE expires_at <= ? LIMIT 200",
		[now],
	);
	if (expired.length === 0) return;
	const bucket = getAttachmentsBucket(context);
	for (const item of expired) {
		try {
			if (item.uploadId && item.uploadId !== "single") {
				const upload = bucket.resumeMultipartUpload(item.r2Key, item.uploadId);
				await upload.abort();
			}
		} catch {
		}
		try {
			await bucket.delete(item.r2Key);
		} catch {
		}
		try {
			await execute(db, "DELETE FROM comment_attachment_upload_parts WHERE upload_record_id = ?", [item.id]);
			await execute(db, "DELETE FROM comment_attachment_uploads WHERE id = ?", [item.id]);
		} catch {
		}
	}
}

export async function countCommentAttachmentsForComment(context: AppLoadContext, commentId: number) {
	const db = getDBFromContext(context);
	const row = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM comment_attachments WHERE comment_id = ?",
		[commentId],
	);
	return Number(row?.count ?? 0);
}

export async function countActiveCommentUploadsForComment(context: AppLoadContext, commentId: number, now = Date.now()) {
	const db = getDBFromContext(context);
	const row = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM comment_attachment_uploads WHERE comment_id = ? AND expires_at > ?",
		[commentId, now],
	);
	return Number(row?.count ?? 0);
}

export async function createCommentUploadRecord(args: {
	context: AppLoadContext;
	postId: number;
	commentId: number;
	uploaderId: number;
	filename: string;
	mimeType: string;
	sizeBytes: number;
}) {
	const now = Date.now();
	await cleanupExpiredCommentUploads(args.context, now);
	await assertWithinSiteStorageQuota({ context: args.context, extraBytes: args.sizeBytes, now });
	const existing = await countCommentAttachmentsForComment(args.context, args.commentId);
	let active = await countActiveCommentUploadsForComment(args.context, args.commentId, now);
	if (existing + active >= MAX_ATTACHMENTS_PER_COMMENT) {
		if (existing < MAX_ATTACHMENTS_PER_COMMENT && active > 0) {
			const db = getDBFromContext(args.context);
			const rows = await queryAll<{ id: number; r2Key: string; uploadId: string }>(
				db,
				"SELECT id as id, r2_key as r2Key, upload_id as uploadId FROM comment_attachment_uploads WHERE comment_id = ? AND uploader_id = ? AND expires_at > ?",
				[args.commentId, args.uploaderId, now],
			);
			let bucket: R2Bucket | null = null;
			try {
				bucket = getAttachmentsBucket(args.context);
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
					if (bucket) {
						await bucket.delete(row.r2Key);
					}
				} catch {
				}
				try {
					await execute(db, "DELETE FROM comment_attachment_upload_parts WHERE upload_record_id = ?", [row.id]);
					await execute(db, "DELETE FROM comment_attachment_uploads WHERE id = ?", [row.id]);
				} catch {
				}
			}
			active = await countActiveCommentUploadsForComment(args.context, args.commentId, now);
		}
		if (existing + active >= MAX_ATTACHMENTS_PER_COMMENT) {
			throw new Response("每条评论最多上传 3 个附件", { status: 400 });
		}
	}
	const db = getDBFromContext(args.context);
	const usedRow = await queryOne<{ sum: number | string | null }>(
		db,
		"SELECT COALESCE(SUM(size_bytes), 0) as sum FROM comment_attachments WHERE comment_id = ?",
		[args.commentId],
	);
	const reservedRow = await queryOne<{ sum: number | string | null }>(
		db,
		"SELECT COALESCE(SUM(size_bytes), 0) as sum FROM comment_attachment_uploads WHERE comment_id = ? AND expires_at > ?",
		[args.commentId, now],
	);
	const usedBytes = Number(usedRow?.sum ?? 0);
	const reservedBytes = Number(reservedRow?.sum ?? 0);
	if (usedBytes + reservedBytes + args.sizeBytes > MAX_TOTAL_COMMENT_BYTES) {
		throw new Response("单条评论附件总大小最多 500MB", { status: 400 });
	}
	const safeName = sanitizeFilename(args.filename);
	const key = `posts/${args.postId}/comments/${args.commentId}/${crypto.randomUUID()}_${safeName}`;
	const bucket = getAttachmentsBucket(args.context);
	const expiresAt = now + UPLOAD_EXPIRES_MS;
	const mode = getUploadMode({ sizeBytes: args.sizeBytes, filename: safeName });
	let uploadId = "single";
	if (mode === "multipart") {
		const upload = await bucket.createMultipartUpload(key, {
			httpMetadata: { contentType: args.mimeType },
			customMetadata: {
				postId: String(args.postId),
				commentId: String(args.commentId),
				uploaderId: String(args.uploaderId),
				filename: safeName,
			},
		});
		uploadId = upload.uploadId;
	}
	await execute(
		db,
		"INSERT INTO comment_attachment_uploads (post_id, uploader_id, comment_id, r2_key, upload_id, filename, mime_type, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			args.postId,
			args.uploaderId,
			args.commentId,
			key,
			uploadId,
			safeName,
			args.mimeType,
			args.sizeBytes,
			now,
			expiresAt,
		],
	);
	const record = await queryOne<CommentAttachmentUploadRecord>(
		db,
		"SELECT id as id, comment_id as commentId, post_id as postId, uploader_id as uploaderId, r2_key as r2Key, upload_id as uploadId, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt, expires_at as expiresAt FROM comment_attachment_uploads WHERE r2_key = ?",
		[key],
	);
	if (!record) {
		throw new Response("创建上传任务失败", { status: 500 });
	}
	return {
		record,
		mode,
		partSizeBytes: mode === "multipart" ? PART_SIZE_BYTES : null,
	};
}

export async function getCommentUploadRecord(context: AppLoadContext, uploadRecordId: number) {
	const db = getDBFromContext(context);
	const record = await queryOne<CommentAttachmentUploadRecord>(
		db,
		"SELECT id as id, comment_id as commentId, post_id as postId, uploader_id as uploaderId, r2_key as r2Key, upload_id as uploadId, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt, expires_at as expiresAt FROM comment_attachment_uploads WHERE id = ?",
		[uploadRecordId],
	);
	return record;
}

export async function saveUploadedCommentPart(args: {
	context: AppLoadContext;
	uploadRecordId: number;
	partNumber: number;
	etag: string;
	sizeBytes: number;
}) {
	const db = getDBFromContext(args.context);
	await execute(
		db,
		"DELETE FROM comment_attachment_upload_parts WHERE upload_record_id = ? AND part_number = ?",
		[args.uploadRecordId, args.partNumber],
	);
	await execute(
		db,
		"INSERT INTO comment_attachment_upload_parts (upload_record_id, part_number, etag, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)",
		[args.uploadRecordId, args.partNumber, args.etag, args.sizeBytes, Date.now()],
	);
}

export async function listUploadedCommentParts(context: AppLoadContext, uploadRecordId: number) {
	const db = getDBFromContext(context);
	const parts = await queryAll<{ partNumber: number; etag: string }>(
		db,
		"SELECT part_number as partNumber, etag as etag FROM comment_attachment_upload_parts WHERE upload_record_id = ? ORDER BY part_number ASC",
		[uploadRecordId],
	);
	return parts;
}

export async function finalizeUploadToCommentAttachment(args: { context: AppLoadContext; uploadRecordId: number }) {
	const db = getDBFromContext(args.context);
	const record = await getCommentUploadRecord(args.context, args.uploadRecordId);
	if (!record) {
		throw new Response("上传任务不存在", { status: 404 });
	}
	if (!record.commentId) {
		throw new Response("上传任务未绑定评论", { status: 400 });
	}
	await execute(
		db,
		"INSERT INTO comment_attachments (comment_id, post_id, uploader_id, r2_key, filename, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		[
			record.commentId,
			record.postId,
			record.uploaderId,
			record.r2Key,
			record.filename,
			record.mimeType,
			record.sizeBytes,
			Date.now(),
		],
	);
	await execute(db, "DELETE FROM comment_attachment_upload_parts WHERE upload_record_id = ?", [record.id]);
	await execute(db, "DELETE FROM comment_attachment_uploads WHERE id = ?", [record.id]);
}

export async function removeAllCommentAttachmentsForPost(context: AppLoadContext, postId: number) {
	const db = getDBFromContext(context);
	const rows = await queryAll<{ id: number; r2Key: string }>(
		db,
		"SELECT id as id, r2_key as r2Key FROM comment_attachments WHERE post_id = ?",
		[postId],
	);
	await execute(db, "DELETE FROM comment_attachments WHERE post_id = ?", [postId]);
	await execute(
		db,
		"DELETE FROM comment_attachment_upload_parts WHERE upload_record_id IN (SELECT id FROM comment_attachment_uploads WHERE post_id = ?)",
		[postId],
	);
	await execute(db, "DELETE FROM comment_attachment_uploads WHERE post_id = ?", [postId]);
	let bucket: R2Bucket | null = null;
	try {
		bucket = getAttachmentsBucket(context);
	} catch {
		bucket = null;
	}
	if (!bucket) return;
	for (const item of rows) {
		try {
			await bucket.delete(item.r2Key);
		} catch {
		}
	}
}

export async function getAttachmentById(context: AppLoadContext, attachmentId: number) {
	const db = getDBFromContext(context);
	const row = await queryOne<AttachmentRecord>(
		db,
		"SELECT id as id, post_id as postId, uploader_id as uploaderId, r2_key as r2Key, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt FROM attachments WHERE id = ?",
		[attachmentId],
	);
	return row;
}

export async function createUploadRecord(args: {
	context: AppLoadContext;
	postId: number;
	uploaderId: number;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	bypassCountLimit?: boolean;
}) {
	const now = Date.now();
	await cleanupExpiredUploads(args.context, now);
	await assertWithinSiteStorageQuota({ context: args.context, extraBytes: args.sizeBytes, now });
	const existing = await countAttachmentsForPost(args.context, args.postId);
	let active = await countActiveUploadsForPost(args.context, args.postId, now);
	const countAtStart = existing + active;
	const bypassCountLimit = Boolean(args.bypassCountLimit);
	const countLimitBypassed = bypassCountLimit && countAtStart >= MAX_ATTACHMENTS_PER_POST;
	if (!bypassCountLimit && countAtStart >= MAX_ATTACHMENTS_PER_POST) {
		if (existing < MAX_ATTACHMENTS_PER_POST && active > 0) {
			const db = getDBFromContext(args.context);
			const rows = await queryAll<{ id: number; r2Key: string; uploadId: string }>(
				db,
				"SELECT id as id, r2_key as r2Key, upload_id as uploadId FROM attachment_uploads WHERE post_id = ? AND uploader_id = ? AND expires_at > ?",
				[args.postId, args.uploaderId, now],
			);
			let bucket: R2Bucket | null = null;
			try {
				bucket = getAttachmentsBucket(args.context);
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
					if (bucket) {
						await bucket.delete(row.r2Key);
					}
				} catch {
				}
				try {
					await execute(db, "DELETE FROM attachment_upload_parts WHERE upload_record_id = ?", [row.id]);
					await execute(db, "DELETE FROM attachment_uploads WHERE id = ?", [row.id]);
				} catch {
				}
			}
			active = await countActiveUploadsForPost(args.context, args.postId, now);
		}
		if (existing + active >= MAX_ATTACHMENTS_PER_POST) {
			throw new Response("每个帖子最多上传 3 个附件", { status: 400 });
		}
	}
	const db = getDBFromContext(args.context);
	const usedRow = await queryOne<{ sum: number | string | null }>(
		db,
		"SELECT COALESCE(SUM(size_bytes), 0) as sum FROM attachments WHERE post_id = ?",
		[args.postId],
	);
	const reservedRow = await queryOne<{ sum: number | string | null }>(
		db,
		"SELECT COALESCE(SUM(size_bytes), 0) as sum FROM attachment_uploads WHERE post_id = ? AND expires_at > ?",
		[args.postId, now],
	);
	const usedBytes = Number(usedRow?.sum ?? 0);
	const reservedBytes = Number(reservedRow?.sum ?? 0);
	if (usedBytes + reservedBytes + args.sizeBytes > MAX_TOTAL_POST_BYTES) {
		throw new Response("单帖附件总大小最多 500MB", { status: 400 });
	}
	const safeName = sanitizeFilename(args.filename);
	const key = `posts/${args.postId}/${crypto.randomUUID()}_${safeName}`;
	const bucket = getAttachmentsBucket(args.context);
	const expiresAt = now + UPLOAD_EXPIRES_MS;
	const mode = getUploadMode({ sizeBytes: args.sizeBytes, filename: safeName });
	let uploadId = "single";
	if (mode === "multipart") {
		const upload = await bucket.createMultipartUpload(key, {
			httpMetadata: { contentType: args.mimeType },
			customMetadata: {
				postId: String(args.postId),
				uploaderId: String(args.uploaderId),
				filename: safeName,
			},
		});
		uploadId = upload.uploadId;
	}
	await execute(
		db,
		"INSERT INTO attachment_uploads (post_id, uploader_id, r2_key, upload_id, filename, mime_type, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			args.postId,
			args.uploaderId,
			key,
			uploadId,
			safeName,
			args.mimeType,
			args.sizeBytes,
			now,
			expiresAt,
		],
	);
	const record = await queryOne<AttachmentUploadRecord>(
		db,
		"SELECT id as id, post_id as postId, uploader_id as uploaderId, r2_key as r2Key, upload_id as uploadId, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt, expires_at as expiresAt FROM attachment_uploads WHERE r2_key = ?",
		[key],
	);
	if (!record) {
		throw new Response("创建上传任务失败", { status: 500 });
	}
	return {
		record,
		mode,
		partSizeBytes: mode === "multipart" ? PART_SIZE_BYTES : null,
		countLimitBypassed,
		existingCount: existing,
		activeCount: active,
	};
}

export async function getUploadRecord(context: AppLoadContext, uploadRecordId: number) {
	const db = getDBFromContext(context);
	const record = await queryOne<AttachmentUploadRecord>(
		db,
		"SELECT id as id, post_id as postId, uploader_id as uploaderId, r2_key as r2Key, upload_id as uploadId, filename as filename, mime_type as mimeType, size_bytes as sizeBytes, created_at as createdAt, expires_at as expiresAt FROM attachment_uploads WHERE id = ?",
		[uploadRecordId],
	);
	return record;
}

export async function saveUploadedPart(args: {
	context: AppLoadContext;
	uploadRecordId: number;
	partNumber: number;
	etag: string;
	sizeBytes: number;
}) {
	const db = getDBFromContext(args.context);
	await execute(
		db,
		"DELETE FROM attachment_upload_parts WHERE upload_record_id = ? AND part_number = ?",
		[args.uploadRecordId, args.partNumber],
	);
	await execute(
		db,
		"INSERT INTO attachment_upload_parts (upload_record_id, part_number, etag, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)",
		[args.uploadRecordId, args.partNumber, args.etag, args.sizeBytes, Date.now()],
	);
}

export async function listUploadedParts(context: AppLoadContext, uploadRecordId: number) {
	const db = getDBFromContext(context);
	const parts = await queryAll<{ partNumber: number; etag: string }>(
		db,
		"SELECT part_number as partNumber, etag as etag FROM attachment_upload_parts WHERE upload_record_id = ? ORDER BY part_number ASC",
		[uploadRecordId],
	);
	return parts;
}

export async function finalizeUploadToAttachment(args: { context: AppLoadContext; uploadRecordId: number }) {
	const db = getDBFromContext(args.context);
	const record = await getUploadRecord(args.context, args.uploadRecordId);
	if (!record) {
		throw new Response("上传任务不存在", { status: 404 });
	}
	await execute(
		db,
		"INSERT INTO attachments (post_id, uploader_id, r2_key, filename, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[record.postId, record.uploaderId, record.r2Key, record.filename, record.mimeType, record.sizeBytes, Date.now()],
	);
	await execute(db, "DELETE FROM attachment_upload_parts WHERE upload_record_id = ?", [record.id]);
	await execute(db, "DELETE FROM attachment_uploads WHERE id = ?", [record.id]);
}

export async function removeAttachmentRecord(context: AppLoadContext, attachmentId: number) {
	const db = getDBFromContext(context);
	const record = await queryOne<{ r2Key: string }>(db, "SELECT r2_key as r2Key FROM attachments WHERE id = ?", [
		attachmentId,
	]);
	if (!record) return;
	await execute(db, "DELETE FROM attachments WHERE id = ?", [attachmentId]);
	const bucket = getAttachmentsBucket(context);
	await bucket.delete(record.r2Key);
}

export async function removeAllAttachmentsForPost(context: AppLoadContext, postId: number) {
	const db = getDBFromContext(context);
	const rows = await queryAll<{ id: number; r2Key: string }>(
		db,
		"SELECT id as id, r2_key as r2Key FROM attachments WHERE post_id = ?",
		[postId],
	);
	await execute(db, "DELETE FROM attachments WHERE post_id = ?", [postId]);
	await execute(db, "DELETE FROM attachment_upload_parts WHERE upload_record_id IN (SELECT id FROM attachment_uploads WHERE post_id = ?)", [postId]);
	await execute(db, "DELETE FROM attachment_uploads WHERE post_id = ?", [postId]);
	let bucket: R2Bucket | null = null;
	try {
		bucket = getAttachmentsBucket(context);
	} catch {
		bucket = null;
	}
	if (!bucket) return;
	for (const item of rows) {
		try {
			await bucket.delete(item.r2Key);
		} catch {
		}
	}
}

export async function removeAllAttachmentsForUploader(context: AppLoadContext, uploaderId: number) {
	const db = getDBFromContext(context);
	const rows = await queryAll<{ r2Key: string }>(
		db,
		"SELECT r2_key as r2Key FROM attachments WHERE uploader_id = ?",
		[uploaderId],
	);
	await execute(db, "DELETE FROM attachments WHERE uploader_id = ?", [uploaderId]);
	let bucket: R2Bucket | null = null;
	try {
		bucket = getAttachmentsBucket(context);
	} catch {
		bucket = null;
	}
	if (!bucket) return;
	for (const item of rows) {
		try {
			await bucket.delete(item.r2Key);
		} catch {
		}
	}
}

export async function removeAllCommentAttachmentsForUploader(context: AppLoadContext, uploaderId: number) {
	const db = getDBFromContext(context);
	const rows = await queryAll<{ r2Key: string }>(
		db,
		"SELECT r2_key as r2Key FROM comment_attachments WHERE uploader_id = ?",
		[uploaderId],
	);
	await execute(db, "DELETE FROM comment_attachments WHERE uploader_id = ?", [uploaderId]);
	let bucket: R2Bucket | null = null;
	try {
		bucket = getAttachmentsBucket(context);
	} catch {
		bucket = null;
	}
	if (!bucket) return;
	for (const item of rows) {
		try {
			await bucket.delete(item.r2Key);
		} catch {
		}
	}
}

export async function removeAllCommentAttachmentsForComments(context: AppLoadContext, commentIds: number[]) {
	const ids = commentIds
		.map((n) => Number(n))
		.filter((n) => Number.isFinite(n) && n > 0)
		.map((n) => Math.floor(n));
	const uniqueIds = Array.from(new Set(ids));
	if (uniqueIds.length === 0) return;
	const placeholders = uniqueIds.map(() => "?").join(",");
	const db = getDBFromContext(context);
	const rows = await queryAll<{ r2Key: string }>(
		db,
		`SELECT r2_key as r2Key FROM comment_attachments WHERE comment_id IN (${placeholders})`,
		uniqueIds,
	);
	await execute(db, `DELETE FROM comment_attachments WHERE comment_id IN (${placeholders})`, uniqueIds);
	let bucket: R2Bucket | null = null;
	try {
		bucket = getAttachmentsBucket(context);
	} catch {
		bucket = null;
	}
	if (!bucket) return;
	for (const item of rows) {
		try {
			await bucket.delete(item.r2Key);
		} catch {
		}
	}
}

export async function removeAllAttachmentUploadsForUploader(context: AppLoadContext, uploaderId: number) {
	const db = getDBFromContext(context);
	const rows = await queryAll<{ id: number; r2Key: string; uploadId: string }>(
		db,
		"SELECT id as id, r2_key as r2Key, upload_id as uploadId FROM attachment_uploads WHERE uploader_id = ?",
		[uploaderId],
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
			if (bucket) {
				await bucket.delete(row.r2Key);
			}
		} catch {
		}
	}
	const ids = rows.map((r) => r.id);
	const placeholders = ids.map(() => "?").join(",");
	await execute(db, `DELETE FROM attachment_upload_parts WHERE upload_record_id IN (${placeholders})`, ids);
	await execute(db, `DELETE FROM attachment_uploads WHERE id IN (${placeholders})`, ids);
}

export async function removeAllCommentAttachmentUploadsForComments(context: AppLoadContext, commentIds: number[]) {
	const ids = commentIds
		.map((n) => Number(n))
		.filter((n) => Number.isFinite(n) && n > 0)
		.map((n) => Math.floor(n));
	const uniqueIds = Array.from(new Set(ids));
	if (uniqueIds.length === 0) return;
	const db = getDBFromContext(context);
	const placeholders = uniqueIds.map(() => "?").join(",");
	const rows = await queryAll<{ id: number; r2Key: string; uploadId: string }>(
		db,
		`SELECT id as id, r2_key as r2Key, upload_id as uploadId FROM comment_attachment_uploads WHERE comment_id IN (${placeholders})`,
		uniqueIds,
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
			if (bucket) {
				await bucket.delete(row.r2Key);
			}
		} catch {
		}
	}
	const uploadIds = rows.map((r) => r.id);
	const uploadPlaceholders = uploadIds.map(() => "?").join(",");
	await execute(
		db,
		`DELETE FROM comment_attachment_upload_parts WHERE upload_record_id IN (${uploadPlaceholders})`,
		uploadIds,
	);
	await execute(db, `DELETE FROM comment_attachment_uploads WHERE id IN (${uploadPlaceholders})`, uploadIds);
}

export async function removeAllCommentAttachmentUploadsForUploader(context: AppLoadContext, uploaderId: number) {
	const db = getDBFromContext(context);
	const rows = await queryAll<{ id: number; r2Key: string; uploadId: string }>(
		db,
		"SELECT id as id, r2_key as r2Key, upload_id as uploadId FROM comment_attachment_uploads WHERE uploader_id = ?",
		[uploaderId],
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
			if (bucket) {
				await bucket.delete(row.r2Key);
			}
		} catch {
		}
	}
	const ids = rows.map((r) => r.id);
	const placeholders = ids.map(() => "?").join(",");
	await execute(db, `DELETE FROM comment_attachment_upload_parts WHERE upload_record_id IN (${placeholders})`, ids);
	await execute(db, `DELETE FROM comment_attachment_uploads WHERE id IN (${placeholders})`, ids);
}

async function sha256(input: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function getTokenSecret(context: AppLoadContext) {
	const env = getEnv(context) as any;
	return String(env.ATTACHMENT_TOKEN_SECRET || env.SESSION_SECRET || "");
}

export async function signAttachmentDownloadToken(args: {
	context: AppLoadContext;
	attachmentId: number;
	userId: number;
	expiresAt: number;
}) {
	const data = `a=${args.attachmentId}&u=${args.userId}&e=${args.expiresAt}`;
	const secret = getTokenSecret(args.context);
	const sig = await sha256(`${secret}:${data}`);
	return `${data}&s=${sig}`;
}

export async function verifyAttachmentDownloadToken(args: {
	context: AppLoadContext;
	token: string;
	attachmentId: number;
	userId: number;
	now?: number;
}) {
	const now = args.now ?? Date.now();
	const params = new URLSearchParams(args.token);
	const a = Number(params.get("a") || "0");
	const u = Number(params.get("u") || "0");
	const e = Number(params.get("e") || "0");
	const s = String(params.get("s") || "");
	if (!a || !u || !e || !s) return false;
	if (a !== args.attachmentId || u !== args.userId) return false;
	if (e <= now) return false;
	const data = `a=${a}&u=${u}&e=${e}`;
	const secret = getTokenSecret(args.context);
	const expected = await sha256(`${secret}:${data}`);
	return expected === s;
}

export async function signCommentAttachmentDownloadToken(args: {
	context: AppLoadContext;
	commentAttachmentId: number;
	userId: number;
	expiresAt: number;
}) {
	const data = `ca=${args.commentAttachmentId}&u=${args.userId}&e=${args.expiresAt}`;
	const secret = getTokenSecret(args.context);
	const sig = await sha256(`${secret}:${data}`);
	return `${data}&s=${sig}`;
}

export async function verifyCommentAttachmentDownloadToken(args: {
	context: AppLoadContext;
	token: string;
	commentAttachmentId: number;
	userId: number;
	now?: number;
}) {
	const now = args.now ?? Date.now();
	const params = new URLSearchParams(args.token);
	const ca = Number(params.get("ca") || "0");
	const u = Number(params.get("u") || "0");
	const e = Number(params.get("e") || "0");
	const s = String(params.get("s") || "");
	if (!ca || !u || !e || !s) return false;
	if (ca !== args.commentAttachmentId || u !== args.userId) return false;
	if (e <= now) return false;
	const data = `ca=${ca}&u=${u}&e=${e}`;
	const secret = getTokenSecret(args.context);
	const expected = await sha256(`${secret}:${data}`);
	return expected === s;
}

export function containsEicarBytes(bytes: Uint8Array) {
	const pattern = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE";
	const text = new TextDecoder().decode(bytes);
	return text.includes(pattern);
}

export function wrapStreamWithEicarScan(stream: ReadableStream<Uint8Array>) {
	const pattern = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE";
	let tail = "";
	const ts = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			const text = tail + new TextDecoder().decode(chunk);
			if (text.includes(pattern)) {
				controller.error(new Error("病毒扫描未通过"));
				return;
			}
			tail = text.slice(-pattern.length);
			controller.enqueue(chunk);
		},
	});
	return stream.pipeThrough(ts);
}

export function formatContentDisposition(filename: string) {
	const safe = sanitizeFilename(filename);
	const encoded = encodeURIComponent(safe);
	return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

export function getUploadMode(args: { sizeBytes: number; filename: string }): "single" | "multipart" {
	const ext = getFileExtension(args.filename);
	if (ext && archiveExtensions.has(ext)) {
		return "single";
	}
	return args.sizeBytes >= MULTIPART_THRESHOLD_BYTES ? "multipart" : "single";
}

export const attachmentLimits = {
	MIN_FILE_SIZE_BYTES,
	MAX_FILE_SIZE_BYTES,
	MAX_ATTACHMENTS_PER_POST,
	MAX_TOTAL_POST_BYTES,
	MAX_ATTACHMENTS_PER_COMMENT,
	MAX_TOTAL_COMMENT_BYTES,
	MULTIPART_THRESHOLD_BYTES,
	PART_SIZE_BYTES,
};

export { attachmentStorageLimits, formatTotalStorageLimit, normalizeTotalStorageLimitBytes };
