import type { AppLoadContext } from "@remix-run/cloudflare";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";

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

const MIN_FILE_SIZE_BYTES = 1024;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_POST = 3;
const MAX_TOTAL_POST_BYTES = 500 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_COMMENT = 3;
const MAX_TOTAL_COMMENT_BYTES = 500 * 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024;
const PART_SIZE_BYTES = 5 * 1024 * 1024;
const UPLOAD_EXPIRES_MS = 60 * 60 * 1000;
const MAX_TOTAL_STORAGE_BYTES = 9 * 1024 * 1024 * 1024;

const allowedExtensions = new Set([
	"pdf",
	"txt",
	"md",
	"csv",
	"json",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"mp4",
	"mov",
	"webm",
	"mp3",
	"wav",
	"zip",
	"rar",
	"7z",
	"tar",
	"gz",
]);

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
	options?: { bypassMaxSize?: boolean },
) {
	const size = args.sizeBytes;
	if (!Number.isFinite(size) || size < MIN_FILE_SIZE_BYTES) {
		return "文件大小需在 1KB 到 100MB 之间";
	}
	if (!options?.bypassMaxSize && size > MAX_FILE_SIZE_BYTES) {
		return "文件大小需在 1KB 到 100MB 之间";
	}
	const ext = getFileExtension(args.filename);
	if (!ext || !allowedExtensions.has(ext)) {
		return "不支持的文件类型";
	}
	if (ext === "svg" || ext === "html" || ext === "js") {
		return "不支持的文件类型";
	}
	const mime = String(args.mimeType || "").toLowerCase();
	if (!mime || mime.includes("javascript") || mime.includes("html")) {
		return "不支持的文件类型";
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
	const limitBytes = MAX_TOTAL_STORAGE_BYTES;
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
		throw new Response("网站总存储量已超过 9GB，已暂停附件上传", { status: 400 });
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
	isSuperadmin?: boolean;
}) {
	const now = Date.now();
	await cleanupExpiredCommentUploads(args.context, now);
	await assertWithinSiteStorageQuota({ context: args.context, extraBytes: args.sizeBytes, now });
	const isSuperadmin = Boolean(args.isSuperadmin);
	const existing = await countCommentAttachmentsForComment(args.context, args.commentId);
	let active = await countActiveCommentUploadsForComment(args.context, args.commentId, now);
	if (!isSuperadmin && existing + active >= MAX_ATTACHMENTS_PER_COMMENT) {
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
	if (!isSuperadmin && usedBytes + reservedBytes + args.sizeBytes > MAX_TOTAL_COMMENT_BYTES) {
		throw new Response("单条评论附件总大小最多 500MB", { status: 400 });
	}
	const safeName = sanitizeFilename(args.filename);
	const key = `posts/${args.postId}/comments/${args.commentId}/${crypto.randomUUID()}_${safeName}`;
	const bucket = getAttachmentsBucket(args.context);
	const expiresAt = now + UPLOAD_EXPIRES_MS;
	let uploadId = "single";
	let mode: "single" | "multipart" = "single";
	if (args.sizeBytes >= MULTIPART_THRESHOLD_BYTES) {
		mode = "multipart";
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
	isSuperadmin?: boolean;
}) {
	const now = Date.now();
	await cleanupExpiredUploads(args.context, now);
	await assertWithinSiteStorageQuota({ context: args.context, extraBytes: args.sizeBytes, now });
	const isSuperadmin = Boolean(args.isSuperadmin);
	const existing = await countAttachmentsForPost(args.context, args.postId);
	let active = await countActiveUploadsForPost(args.context, args.postId, now);
	if (!isSuperadmin && existing + active >= MAX_ATTACHMENTS_PER_POST) {
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
	if (!isSuperadmin && usedBytes + reservedBytes + args.sizeBytes > MAX_TOTAL_POST_BYTES) {
		throw new Response("单帖附件总大小最多 500MB", { status: 400 });
	}
	const safeName = sanitizeFilename(args.filename);
	const key = `posts/${args.postId}/${crypto.randomUUID()}_${safeName}`;
	const bucket = getAttachmentsBucket(args.context);
	const expiresAt = now + UPLOAD_EXPIRES_MS;
	let uploadId = "single";
	let mode: "single" | "multipart" = "single";
	if (args.sizeBytes >= MULTIPART_THRESHOLD_BYTES) {
		mode = "multipart";
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

export function getUploadMode(sizeBytes: number) {
	return sizeBytes >= MULTIPART_THRESHOLD_BYTES ? "multipart" : "single";
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

export const attachmentStorageLimits = {
	MAX_TOTAL_STORAGE_BYTES,
};
