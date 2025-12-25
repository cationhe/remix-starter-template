import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getDBFromContext, queryAll, queryOne, execute } from "~/lib/d1.server";
import { getSession } from "~/lib/session.server";
import {
	assertAdmin,
	assertNotBanned,
	consumeDailyQuota,
	findUserById,
	getClientIp,
	requireUser,
	sendEmail,
} from "~/lib/auth.server";
import {
	getAttachmentStorageUsage,
	getAttachmentsBucket,
	listAttachmentsByPostId,
	listCommentAttachmentsByCommentIds,
	removeAllAttachmentsForPost,
	removeAllCommentAttachmentsForPost,
} from "~/lib/attachments.server";
import { formatTotalStorageLimit } from "~/lib/attachment-storage";
import type { AttachmentRecord, CommentAttachmentRecord } from "~/lib/attachments.server";

const attachmentLimits = {
	MIN_FILE_SIZE_BYTES: 1024,
	MAX_FILE_SIZE_BYTES: 100 * 1024 * 1024,
	MAX_ATTACHMENTS_PER_POST: 3,
	MAX_TOTAL_POST_BYTES: 500 * 1024 * 1024,
	MAX_ATTACHMENTS_PER_COMMENT: 3,
	MAX_TOTAL_COMMENT_BYTES: 500 * 1024 * 1024,
	MULTIPART_THRESHOLD_BYTES: 10 * 1024 * 1024,
	PART_SIZE_BYTES: 5 * 1024 * 1024,
} as const;

type PostDetail = {
	id: number;
	title: string;
	content: string;
	createdAt: number;
	authorId: number;
	authorName: string;
	isBanned: number;
	bannedAt: number | null;
	bannedBy: number | null;
	bannedReason: string | null;
	pinnedUntilMs: number | null;
	pinnedAt: number | null;
	pinnedBy: number | null;
};

type CommentItem = {
	id: number;
	content: string;
	createdAt: number;
	authorId: number;
	authorName: string;
	attachments: CommentAttachmentRecord[];
};

type LoaderData = {
	user: Awaited<ReturnType<typeof findUserById>>;
	post: PostDetail;
	attachments: AttachmentRecord[];
	attachmentStorage: {
		usedBytes: number;
		reservedBytes: number;
		limitBytes: number;
		paused: boolean;
	};
	comments: CommentItem[];
	commentCount: number;
	likeCount: number;
	likedByMe: boolean;
	page: number;
	pageSize: number;
	totalPages: number;
};

type ActionData = {
	fieldErrors?: {
		content?: string;
	};
	formError?: string;
};

function parsePositiveInt(value: string | null, fallback: number) {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
	const session = await getSession(request, context);
	const userId = session.get("userId") as number | undefined;
	let user: Awaited<ReturnType<typeof findUserById>> = null;
	if (userId) {
		user = await findUserById(context, userId);
	}

	const url = new URL(request.url);
	const pageSize = 20;
	const requestedPage = parsePositiveInt(url.searchParams.get("page"), 1);

	const rawId = params.id;
	const id = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(id)) {
		throw new Response("无效的帖子ID", { status: 400 });
	}
	const db = getDBFromContext(context);
	const post = await queryOne<PostDetail>(
		db,
		"SELECT posts.id as id, posts.title as title, posts.content as content, posts.created_at as createdAt, posts.author_id as authorId, users.display_name as authorName, posts.is_banned as isBanned, posts.banned_at as bannedAt, posts.banned_by as bannedBy, posts.banned_reason as bannedReason, posts.pinned_until_ms as pinnedUntilMs, posts.pinned_at as pinnedAt, posts.pinned_by as pinnedBy FROM posts JOIN users ON posts.author_id = users.id WHERE posts.id = ? AND posts.deleted_at IS NULL",
		[id],
	);
	if (!post) {
		throw new Response("帖子不存在", { status: 404 });
	}

	const commentCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM comments WHERE post_id = ? AND deleted_at IS NULL",
		[id],
	);
	const commentCount = Number(commentCountRow?.count ?? 0);
	const totalPages = Math.max(1, Math.ceil(commentCount / pageSize));
	const page = Math.min(requestedPage, totalPages);
	const offset = (page - 1) * pageSize;

	const likeCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM post_likes WHERE post_id = ?",
		[id],
	);
	const likeCount = Number(likeCountRow?.count ?? 0);

	let likedByMe = false;
	if (userId) {
		const liked = await queryOne<{ liked: number }>(
			db,
			"SELECT 1 as liked FROM post_likes WHERE post_id = ? AND user_id = ? LIMIT 1",
			[id, userId],
		);
		likedByMe = Boolean(liked?.liked);
	}

	const comments = await queryAll<CommentItem>(
		db,
		"SELECT comments.id as id, comments.content as content, comments.created_at as createdAt, comments.author_id as authorId, users.display_name as authorName FROM comments JOIN users ON comments.author_id = users.id WHERE comments.post_id = ? AND comments.deleted_at IS NULL ORDER BY comments.created_at ASC LIMIT ? OFFSET ?",
		[id, pageSize, offset],
	);

	const commentAttachmentRows = await listCommentAttachmentsByCommentIds(
		context,
		comments.map((c) => c.id),
	);
	const commentAttachmentMap = new Map<number, CommentAttachmentRecord[]>();
	for (const a of commentAttachmentRows) {
		const list = commentAttachmentMap.get(a.commentId) || [];
		list.push(a);
		commentAttachmentMap.set(a.commentId, list);
	}
	const commentsWithAttachments = comments.map((c) => ({
		...c,
		attachments: commentAttachmentMap.get(c.id) || [],
	}));

	const attachments = await listAttachmentsByPostId(context, id);
	const attachmentStorage = await getAttachmentStorageUsage(context);

	return json<LoaderData>({
		user,
		post,
		attachments,
		attachmentStorage,
		comments: commentsWithAttachments,
		commentCount,
		likeCount,
		likedByMe,
		page,
		pageSize,
		totalPages,
	});
}

export async function action({ request, context, params }: ActionFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);
	const userId = user.id;
	const rawId = params.id;
	const postId = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(postId)) {
		return json<ActionData>({ formError: "无效的帖子ID" }, { status: 400 });
	}
	const formData = await request.formData();
	const intent = String(formData.get("intent") || "comment");
	const db = getDBFromContext(context);
	const currentUrl = new URL(request.url);
	const wantsJson = Boolean(request.headers.get("Accept")?.includes("application/json"));
	const ip = getClientIp(request);
	const userAgent = request.headers.get("User-Agent");

	if (intent === "banPost") {
		assertAdmin(user);
		const reason = String(formData.get("reason") || "").trim();
		if (!reason) {
			return json<ActionData>({ formError: "请输入封禁原因" }, { status: 400 });
		}
		const postRow = await queryOne<{ authorId: number; isBanned: number }>(
			db,
			"SELECT author_id as authorId, is_banned as isBanned FROM posts WHERE id = ? AND deleted_at IS NULL",
			[postId],
		);
		if (!postRow) {
			return json<ActionData>({ formError: "帖子不存在" }, { status: 404 });
		}
		if (postRow.isBanned) {
			return json<ActionData>({ formError: "帖子已封禁" }, { status: 400 });
		}
		const now = Date.now();
		await execute(
			db,
			"UPDATE posts SET is_banned = 1, banned_at = ?, banned_by = ?, banned_reason = ? WHERE id = ?",
			[now, userId, reason, postId],
		);
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "post_banned", ip, userAgent, JSON.stringify({ postId, postAuthorId: postRow.authorId, reason }), now],
			);
		} catch {
		}
		if (user.role === "admin") {
			const env = (context as any).cloudflare?.env as any;
			const to = String(env?.SUPERADMIN_EMAIL || "").trim();
			if (to) {
				const subject = "管理员封禁了帖子";
				const text =
					`管理员已封禁帖子（ID: ${postId}）。\n\n` +
					`封禁原因：${reason}\n` +
					`操作者：${user.displayName}（ID: ${userId}）\n` +
					`时间：${new Date(now).toLocaleString()}`;
				try {
					await sendEmail(context, { to, subject, text });
					try {
						await execute(
							db,
							"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
							[userId, "post_ban_notify_superadmin_sent", ip, userAgent, JSON.stringify({ postId, to }), Date.now()],
						);
					} catch {
					}
				} catch (error) {
					try {
						await execute(
							db,
							"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
							[
								userId,
								"post_ban_notify_superadmin_failed",
								ip,
								userAgent,
								JSON.stringify({ postId, to, message: error instanceof Error ? error.message : "" }),
								Date.now(),
							],
						);
					} catch {
					}
				}
			}
		}
		return redirect(`${currentUrl.pathname}${currentUrl.search}`);
	}

	if (intent === "unbanPost") {
		if (user.role !== "superadmin" && user.role !== "topadmin") {
			return json<ActionData>({ formError: "只有超级管理员可以解封帖子" }, { status: 403 });
		}
		const postRow = await queryOne<{ isBanned: number }>(
			db,
			"SELECT is_banned as isBanned FROM posts WHERE id = ? AND deleted_at IS NULL",
			[postId],
		);
		if (!postRow) {
			return json<ActionData>({ formError: "帖子不存在" }, { status: 404 });
		}
		if (!postRow.isBanned) {
			return json<ActionData>({ formError: "帖子未封禁" }, { status: 400 });
		}
		const now = Date.now();
			await execute(
				db,
				"UPDATE posts SET is_banned = 0, banned_at = NULL, banned_by = NULL, banned_reason = NULL WHERE id = ? AND deleted_at IS NULL",
				[postId],
			);
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "post_unbanned", ip, userAgent, JSON.stringify({ postId }), now],
			);
		} catch {
		}
		return redirect(`${currentUrl.pathname}${currentUrl.search}`);
	}

	if (intent === "setPin") {
		if (user.role !== "superadmin" && user.role !== "topadmin") {
			return json<ActionData>({ formError: "只有超级管理员可以设置置顶" }, { status: 403 });
		}
		const mode = String(formData.get("mode") || "");
		const now = Date.now();
		let pinnedUntilMs: number | null = null;
		if (mode === "off") {
			pinnedUntilMs = null;
		} else if (mode === "permanent") {
			pinnedUntilMs = 0;
		} else if (mode === "1h") {
			pinnedUntilMs = now + 60 * 60 * 1000;
		} else if (mode === "1d") {
			pinnedUntilMs = now + 24 * 60 * 60 * 1000;
		} else if (mode === "7d") {
			pinnedUntilMs = now + 7 * 24 * 60 * 60 * 1000;
		} else {
			return json<ActionData>({ formError: "无效的置顶选项" }, { status: 400 });
		}
		if (pinnedUntilMs === null) {
			await execute(
				db,
				"UPDATE posts SET pinned_until_ms = NULL, pinned_at = NULL, pinned_by = NULL WHERE id = ? AND deleted_at IS NULL",
				[postId],
			);
		} else {
			await execute(
				db,
				"UPDATE posts SET pinned_until_ms = ?, pinned_at = ?, pinned_by = ? WHERE id = ? AND deleted_at IS NULL",
				[pinnedUntilMs, now, userId, postId],
			);
		}
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[userId, "post_pin_set", ip, userAgent, JSON.stringify({ postId, pinnedUntilMs }), now],
			);
		} catch {
		}
		return redirect(`${currentUrl.pathname}${currentUrl.search}`);
	}

	if (intent === "deleteBannedPost") {
		if (user.role !== "superadmin" && user.role !== "topadmin") {
			return json<ActionData>({ formError: "只有超级管理员可以删除封禁帖子" }, { status: 403 });
		}
		const postRow = await queryOne<{ isBanned: number }>(
			db,
			"SELECT is_banned as isBanned FROM posts WHERE id = ? AND deleted_at IS NULL",
			[postId],
		);
		if (!postRow) {
			return json<ActionData>({ formError: "帖子不存在" }, { status: 404 });
		}
		if (!postRow.isBanned) {
			return json<ActionData>({ formError: "只能删除已封禁的帖子" }, { status: 400 });
		}
		try {
			await removeAllAttachmentsForPost(context, postId);
			await removeAllCommentAttachmentsForPost(context, postId);
			await execute(db, "DELETE FROM post_likes WHERE post_id = ?", [postId]);
			await execute(db, "DELETE FROM comments WHERE post_id = ?", [postId]);
			await execute(db, "DELETE FROM posts WHERE id = ?", [postId]);
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[userId, "post_deleted_by_superadmin", ip, userAgent, JSON.stringify({ postId }), Date.now()],
				);
			} catch {
			}
			return redirect("/posts");
		} catch {
			return json<ActionData>({ formError: "删除失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "delete") {
		const postOwner = await queryOne<{ authorId: number }>(
			db,
			"SELECT author_id as authorId FROM posts WHERE id = ? AND deleted_at IS NULL",
			[postId],
		);
		if (!postOwner) {
			return json<ActionData>({ formError: "帖子不存在" }, { status: 404 });
		}
		if (postOwner.authorId !== userId) {
			return json<ActionData>({ formError: "无权删除该帖子" }, { status: 403 });
		}
		try {
			await removeAllAttachmentsForPost(context, postId);
			await removeAllCommentAttachmentsForPost(context, postId);
			await execute(db, "DELETE FROM post_likes WHERE post_id = ?", [postId]);
			await execute(db, "DELETE FROM comments WHERE post_id = ?", [postId]);
			await execute(db, "DELETE FROM posts WHERE id = ?", [postId]);
			return redirect("/posts");
		} catch (error) {
			return json<ActionData>({ formError: "删帖失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "toggleLike") {
		const postOwner = await queryOne<{ authorId: number }>(
			db,
			"SELECT author_id as authorId FROM posts WHERE id = ? AND deleted_at IS NULL",
			[postId],
		);
		if (!postOwner) {
			return json<ActionData>({ formError: "帖子不存在" }, { status: 404 });
		}
		if (postOwner.authorId === userId) {
			return json<ActionData>({ formError: "不能给自己的帖子点赞" }, { status: 400 });
		}
		try {
			const liked = await queryOne<{ liked: number }>(
				db,
				"SELECT 1 as liked FROM post_likes WHERE post_id = ? AND user_id = ? LIMIT 1",
				[postId, userId],
			);
			if (liked) {
				await execute(db, "DELETE FROM post_likes WHERE post_id = ? AND user_id = ?", [postId, userId]);
			} else {
				await execute(
					db,
					"INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)",
					[postId, userId, Date.now()],
				);
			}
			return redirect(`${currentUrl.pathname}${currentUrl.search}`);
		} catch (error) {
			return json<ActionData>({ formError: "点赞失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "deletePostAttachments") {
		const postOwner = await queryOne<{ authorId: number }>(
			db,
			"SELECT author_id as authorId FROM posts WHERE id = ? AND deleted_at IS NULL",
			[postId],
		);
		if (!postOwner) {
			return json({ ok: false, error: "帖子不存在" }, { status: 404 });
		}
		if (postOwner.authorId !== userId) {
			return json({ ok: false, error: "无权删除附件" }, { status: 403 });
		}
		const ids = formData
			.getAll("attachmentId")
			.map((v) => Number(v))
			.filter((n) => Number.isFinite(n) && n > 0)
			.map((n) => Math.floor(n));
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) {
			return json({ ok: false, error: "未选择要删除的附件" }, { status: 400 });
		}
		const placeholders = uniqueIds.map(() => "?").join(",");
		const rows = await queryAll<{ id: number; r2Key: string }>(
			db,
			`SELECT id as id, r2_key as r2Key FROM attachments WHERE post_id = ? AND id IN (${placeholders})`,
			[postId, ...uniqueIds],
		);
		if (rows.length === 0) {
			return json({ ok: true, deletedIds: [] });
		}
		try {
			await execute(
				db,
				`DELETE FROM attachments WHERE post_id = ? AND id IN (${placeholders})`,
				[postId, ...uniqueIds],
			);
			let bucket: R2Bucket | null = null;
			try {
				bucket = getAttachmentsBucket(context);
			} catch {
				bucket = null;
			}
			if (bucket) {
				for (const row of rows) {
					try {
						await bucket.delete(row.r2Key);
					} catch {
					}
				}
			}
			const deletedIds = rows.map((r) => r.id);
			if (wantsJson) return json({ ok: true, deletedIds });
			return redirect(`${currentUrl.pathname}${currentUrl.search}`);
		} catch (error) {
			if (error instanceof Response) {
				return json({ ok: false, error: await error.text() }, { status: error.status });
			}
			return json({ ok: false, error: "删除失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "deleteCommentAttachments") {
		const commentIdRaw = String(formData.get("commentId") || "");
		const commentId = Number(commentIdRaw);
		if (!commentIdRaw || Number.isNaN(commentId) || commentId <= 0) {
			return json({ ok: false, error: "无效的评论ID" }, { status: 400 });
		}
		const comment = await queryOne<{ authorId: number; postId: number }>(
			db,
			"SELECT author_id as authorId, post_id as postId FROM comments WHERE id = ? AND deleted_at IS NULL",
			[commentId],
		);
		if (!comment) {
			return json({ ok: false, error: "评论不存在" }, { status: 404 });
		}
		if (comment.postId !== postId) {
			return json({ ok: false, error: "评论不属于当前帖子" }, { status: 400 });
		}
		if (comment.authorId !== userId) {
			return json({ ok: false, error: "无权删除附件" }, { status: 403 });
		}
		const ids = formData
			.getAll("attachmentId")
			.map((v) => Number(v))
			.filter((n) => Number.isFinite(n) && n > 0)
			.map((n) => Math.floor(n));
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) {
			return json({ ok: false, error: "未选择要删除的附件" }, { status: 400 });
		}
		const placeholders = uniqueIds.map(() => "?").join(",");
		const rows = await queryAll<{ id: number; r2Key: string }>(
			db,
			`SELECT id as id, r2_key as r2Key FROM comment_attachments WHERE comment_id = ? AND id IN (${placeholders})`,
			[commentId, ...uniqueIds],
		);
		if (rows.length === 0) {
			return json({ ok: true, deletedIds: [] });
		}
		try {
			await execute(
				db,
				`DELETE FROM comment_attachments WHERE comment_id = ? AND id IN (${placeholders})`,
				[commentId, ...uniqueIds],
			);
			let bucket: R2Bucket | null = null;
			try {
				bucket = getAttachmentsBucket(context);
			} catch {
				bucket = null;
			}
			if (bucket) {
				for (const row of rows) {
					try {
						await bucket.delete(row.r2Key);
					} catch {
					}
				}
			}
			const deletedIds = rows.map((r) => r.id);
			if (wantsJson) return json({ ok: true, deletedIds });
			return redirect(`${currentUrl.pathname}${currentUrl.search}`);
		} catch (error) {
			if (error instanceof Response) {
				return json({ ok: false, error: await error.text() }, { status: error.status });
			}
			return json({ ok: false, error: "删除失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent !== "comment") {
		return json<ActionData>({ formError: "未知操作" }, { status: 400 });
	}

	const postState = await queryOne<{ isBanned: number }>(
		db,
		"SELECT is_banned as isBanned FROM posts WHERE id = ? AND deleted_at IS NULL",
		[postId],
	);
	if (!postState) {
		return json<ActionData>({ formError: "帖子不存在" }, { status: 404 });
	}
	if (postState?.isBanned) {
		return json<ActionData>({ formError: "该帖子已封禁，禁止跟帖回复" }, { status: 403 });
	}

	const content = String(formData.get("content") || "").trim();
	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!content) {
		fieldErrors.content = "请输入评论内容";
	}
	if (fieldErrors.content) {
		return json<ActionData>({ fieldErrors }, { status: 400 });
	}
	try {
		const quota = await consumeDailyQuota({ context, request, user, kind: "comment" });
		if (!quota.ok) {
			return json<ActionData>({ formError: quota.message }, { status: quota.status });
		}
		const createdAt = Date.now();
		await execute(
			db,
			"INSERT INTO comments (post_id, content, author_id, created_at) VALUES (?, ?, ?, ?)",
			[postId, content, userId, createdAt],
		);
		return redirect(`${currentUrl.pathname}${currentUrl.search}`);
	} catch (error) {
		return json<ActionData>({ formError: "发表评论失败，请稍后重试" }, { status: 500 });
	}
}

export default function PostDetailPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	const isBanned = Boolean(data.user?.isBanned);
	const postBanned = Boolean(data.post.isBanned);
	const postPinned =
		data.post.pinnedUntilMs === 0 ||
		(typeof data.post.pinnedUntilMs === "number" && data.post.pinnedUntilMs > Date.now());
	const isAdminUser = Boolean(
		data.user && (data.user.role === "admin" || data.user.role === "superadmin" || data.user.role === "topadmin"),
	);
	const isSuperadminUser = data.user?.role === "superadmin" || data.user?.role === "topadmin";
	const commentStartIndex = (data.page - 1) * data.pageSize;
	const canPrev = data.page > 1;
	const canNext = data.page < data.totalPages;
	const isAuthor = Boolean(data.user && data.user.id === data.post.authorId);
	const canManageAttachments = Boolean(isAuthor && !isBanned);
	const uploadsPaused = data.attachmentStorage.paused;
	const canUpload = Boolean(canManageAttachments && !uploadsPaused);
	const uploadsPausedMessage = `网站总存储量已达到上限（${formatTotalStorageLimit(data.attachmentStorage.limitBytes)}），已暂停附件上传`;
	const maxFilesPerPost = attachmentLimits.MAX_ATTACHMENTS_PER_POST;
	const maxTotalPostBytes = attachmentLimits.MAX_TOTAL_POST_BYTES;
	const maxFileSizeBytesForUser = attachmentLimits.MAX_FILE_SIZE_BYTES;

	type UploadItem = {
		id: string;
		file: File;
		status: "pending" | "uploading" | "done" | "error";
		progress: number;
		error: string | null;
		recoverable: boolean;
	};

	const [attachments, setAttachments] = useState<AttachmentRecord[]>(data.attachments);
	const [comments, setComments] = useState<CommentItem[]>(data.comments);

	const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
	const [queue, setQueue] = useState<UploadItem[]>([]);
	const [busy, setBusy] = useState(false);
	const [globalError, setGlobalError] = useState<string | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const queueRef = useRef<UploadItem[]>([]);

	const remainingSlots = useMemo(() => {
		const existing = attachments.length;
		const uploading = queue.filter((q) => q.status === "pending" || q.status === "uploading").length;
		return Math.max(0, maxFilesPerPost - existing - uploading);
	}, [attachments.length, maxFilesPerPost, queue]);

	const existingBytes = useMemo(() => {
		return attachments.reduce((sum, a) => sum + (Number.isFinite(a.sizeBytes) ? a.sizeBytes : 0), 0);
	}, [attachments]);

	const uploadingBytes = useMemo(() => {
		return queue
			.filter((q) => q.status === "pending" || q.status === "uploading")
			.reduce((sum, q) => sum + (Number.isFinite(q.file.size) ? q.file.size : 0), 0);
	}, [queue]);

	const effectiveSelectedFiles = useMemo(() => {
		return selectedFiles.slice(0, remainingSlots);
	}, [remainingSlots, selectedFiles]);

	type SelectionSizeState = {
		selectedBytes: number;
		remainingBytes: number;
		overLimit: boolean;
	};

	const selectionSize = useMemo<SelectionSizeState>(() => {
		const selectedBytes = effectiveSelectedFiles.reduce(
			(sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0),
			0,
		);
		const remainingBytes = maxTotalPostBytes === Number.POSITIVE_INFINITY
			? Number.POSITIVE_INFINITY
			: Math.max(0, maxTotalPostBytes - existingBytes - uploadingBytes);
		const overLimit = maxTotalPostBytes === Number.POSITIVE_INFINITY ? false : selectedBytes > remainingBytes;
		return { selectedBytes, remainingBytes, overLimit };
	}, [effectiveSelectedFiles, existingBytes, maxTotalPostBytes, uploadingBytes]);

	function formatSize(bytes: number) {
		if (bytes === Number.POSITIVE_INFINITY) return "不限";
		if (!Number.isFinite(bytes) || bytes < 0) return "-";
		if (bytes < 1024) return `${bytes} B`;
		const kb = bytes / 1024;
		if (kb < 1024) return `${kb.toFixed(1)} KB`;
		const mb = kb / 1024;
		if (mb < 1024) return `${mb.toFixed(1)} MB`;
		const gb = mb / 1024;
		return `${gb.toFixed(2)} GB`;
	}

	function validateLocal(file: File) {
		if (file.size < attachmentLimits.MIN_FILE_SIZE_BYTES) {
			return `文件大小需在 ${formatSize(attachmentLimits.MIN_FILE_SIZE_BYTES)} 到 ${formatSize(maxFileSizeBytesForUser)} 之间`;
		}
		if (file.size > attachmentLimits.MAX_FILE_SIZE_BYTES) {
			return `文件大小需在 ${formatSize(attachmentLimits.MIN_FILE_SIZE_BYTES)} 到 ${formatSize(maxFileSizeBytesForUser)} 之间`;
		}
		const name = String(file.name || "");
		const idx = name.lastIndexOf(".");
		const ext = idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
		if (!ext) {
			return "文件必须包含扩展名";
		}
			if (isSuperadminUser) return null;
			const allowed = new Set(["ino", "py", "rar", "zip", "docx", "doc", "pdf", "mp4"]);
			if (!allowed.has(ext)) {
				return "不支持的文件类型";
			}
			return null;
		}

	function isLikelyNetworkError(error: unknown) {
		if (!error) return false;
		if (error instanceof DOMException && error.name === "AbortError") return false;
		return error instanceof TypeError;
	}

	async function fetchWithRetry(
		input: RequestInfo | URL,
		init: RequestInit,
		options: { timeoutMs: number; retries: number },
	) {
		let lastError: unknown = null;
		for (let attempt = 1; attempt <= options.retries; attempt++) {
			const controller = new AbortController();
			const id = setTimeout(() => controller.abort(), options.timeoutMs);
			try {
				const res = await fetch(input, { ...init, signal: controller.signal });
				clearTimeout(id);
				return res;
			} catch (e) {
				clearTimeout(id);
				lastError = e;
				if (!isLikelyNetworkError(e) || attempt >= options.retries) break;
				await new Promise((r) => setTimeout(r, attempt * 300));
			}
		}
		throw lastError instanceof Error ? lastError : new Error("网络错误");
	}

	async function fetchJsonWithRetry<T>(
		input: RequestInfo | URL,
		init: RequestInit,
		options: { timeoutMs: number; retries: number },
	) {
		const res = await fetchWithRetry(input, init, options);
		let data: any = null;
		try {
			data = await res.json();
		} catch {
			data = null;
		}
		return { res, data: data as T };
	}

	useEffect(() => {
		setAttachments(data.attachments);
		setComments(data.comments);
		setSelectedFiles([]);
		setQueue([]);
		setBusy(false);
		setGlobalError(null);
	}, [data.comments, data.post.id, data.attachments]);

	useEffect(() => {
		queueRef.current = queue;
	}, [queue]);

	function normalizeUploadError(error: unknown) {
		if (isLikelyNetworkError(error)) {
			return { message: "网络错误，请检查网络后重试", recoverable: true };
		}
		const message = error instanceof Error ? String(error.message || "上传失败") : "上传失败";
		const lower = message.toLowerCase();
		const recoverable =
			message.includes("请稍后重试") ||
			message.includes("超时") ||
			lower.includes("timeout") ||
			lower.includes("failed to fetch") ||
			lower.includes("network");
		return { message, recoverable };
	}

	async function deletePostAttachments(ids: number[]) {
		if (!canManageAttachments || ids.length === 0) return;
		const names = attachments.filter((a) => ids.includes(a.id)).map((a) => a.filename);
		const ok = window.confirm(
			ids.length === 1
				? `确认删除附件吗？\n\n文件：${names[0] || "(未知文件)"}`
				: `确认删除所选 ${ids.length} 个附件吗？`,
		);
		if (!ok) return;
		setGlobalError(null);
		setDeletingPostAttachmentIds((prev) => {
			const next = { ...prev };
			for (const id of ids) next[id] = true;
			return next;
		});
		const form = new FormData();
		form.append("intent", "deletePostAttachments");
		for (const id of ids) form.append("attachmentId", String(id));
		try {
			const res = await fetch(`${window.location.pathname}${window.location.search}`, {
				method: "POST",
				headers: { Accept: "application/json" },
				body: form,
			});
			const data = (await res.json()) as any;
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "删除失败"));
			}
			const deletedIds = Array.isArray(data.deletedIds) ? (data.deletedIds as any[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0) : [];
			setAttachments((prev) => prev.filter((a) => !deletedIds.includes(a.id)));
			setSelectedAttachmentIds((prev) => prev.filter((id) => !deletedIds.includes(id)));
		} catch (e) {
			setGlobalError(e instanceof Error ? e.message : "删除失败");
		} finally {
			setDeletingPostAttachmentIds((prev) => {
				const next = { ...prev };
				for (const id of ids) delete next[id];
				return next;
			});
		}
	}

	async function deleteCommentAttachments(commentId: number, ids: number[]) {
		if (!data.user || ids.length === 0 || isBanned) return;
		const comment = comments.find((c) => c.id === commentId);
		if (!comment || comment.authorId !== data.user.id) return;
		const names = comment.attachments.filter((a) => ids.includes(a.id)).map((a) => a.filename);
		const ok = window.confirm(
			ids.length === 1
				? `确认删除附件吗？\n\n文件：${names[0] || "(未知文件)"}`
				: `确认删除所选 ${ids.length} 个附件吗？`,
		);
		if (!ok) return;
		setGlobalError(null);
		setDeletingCommentAttachmentIds((prev) => {
			const next = { ...prev };
			for (const id of ids) next[id] = true;
			return next;
		});
		const form = new FormData();
		form.append("intent", "deleteCommentAttachments");
		form.append("commentId", String(commentId));
		for (const id of ids) form.append("attachmentId", String(id));
		try {
			const res = await fetch(`${window.location.pathname}${window.location.search}`, {
				method: "POST",
				headers: { Accept: "application/json" },
				body: form,
			});
			const data = (await res.json()) as any;
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "删除失败"));
			}
			const deletedIds = Array.isArray(data.deletedIds) ? (data.deletedIds as any[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0) : [];
			setComments((prev) =>
				prev.map((c) =>
					c.id === commentId
						? { ...c, attachments: c.attachments.filter((a) => !deletedIds.includes(a.id)) }
						: c,
				),
			);
			setCommentSelectedAttachmentIds((prev) => {
				const current = prev[commentId] || [];
				return { ...prev, [commentId]: current.filter((id) => !deletedIds.includes(id)) };
			});
		} catch (e) {
			setGlobalError(e instanceof Error ? e.message : "删除失败");
		} finally {
			setDeletingCommentAttachmentIds((prev) => {
				const next = { ...prev };
				for (const id of ids) delete next[id];
				return next;
			});
		}
	}

	const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<number[]>([]);
	const [commentSelectedAttachmentIds, setCommentSelectedAttachmentIds] = useState<Record<number, number[]>>({});
	const [deletingPostAttachmentIds, setDeletingPostAttachmentIds] = useState<Record<number, boolean>>({});
	const [deletingCommentAttachmentIds, setDeletingCommentAttachmentIds] = useState<Record<number, boolean>>({});

	function toggleSelectedAttachment(id: number) {
		setSelectedAttachmentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
	}

	function toggleSelectedCommentAttachment(commentId: number, attachmentId: number) {
		setCommentSelectedAttachmentIds((prev) => {
			const current = prev[commentId] || [];
			const next = current.includes(attachmentId) ? current.filter((x) => x !== attachmentId) : [...current, attachmentId];
			return { ...prev, [commentId]: next };
		});
	}

	async function requestDownload(attachmentId: number) {
		setGlobalError(null);
		try {
			const { res, data } = await fetchJsonWithRetry<any>(
				`/api/attachments/${attachmentId}/token`,
				{ method: "GET" },
				{ timeoutMs: 15_000, retries: 3 },
			);
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "获取下载链接失败"));
			}
			const token = String(data.token || "");
			window.location.href = `/attachments/${attachmentId}?token=${encodeURIComponent(token)}`;
		} catch (e) {
			setGlobalError(e instanceof Error ? e.message : "获取下载链接失败");
		}
	}

	async function requestCommentDownload(commentAttachmentId: number) {
		setGlobalError(null);
		try {
			const { res, data } = await fetchJsonWithRetry<any>(
				`/api/comment-attachments/${commentAttachmentId}/token`,
				{ method: "GET" },
				{ timeoutMs: 15_000, retries: 3 },
			);
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "获取下载链接失败"));
			}
			const token = String(data.token || "");
			window.location.href = `/comment-attachments/${commentAttachmentId}?token=${encodeURIComponent(token)}`;
		} catch (e) {
			setGlobalError(e instanceof Error ? e.message : "获取下载链接失败");
		}
	}

	type CommentUploadState = {
		selectedFiles: File[];
		queue: UploadItem[];
		busy: boolean;
		error: string | null;
	};

	const [commentUploads, setCommentUploads] = useState<Record<number, CommentUploadState>>({});
	const commentUploadsRef = useRef<Record<number, CommentUploadState>>({});

	function updateCommentUploads(commentId: number, updater: (current: CommentUploadState) => CommentUploadState) {
		setCommentUploads((prev) => {
			const current = prev[commentId] || { selectedFiles: [], queue: [], busy: false, error: null };
			return { ...prev, [commentId]: updater(current) };
		});
	}

	useEffect(() => {
		commentUploadsRef.current = commentUploads;
	}, [commentUploads]);

	async function retryUploadItem(itemId: string) {
		if (!canUpload || busy) return;
		const item = queueRef.current.find((q) => q.id === itemId);
		if (!item || item.status !== "error") return;
		setGlobalError(null);
		setBusy(true);
		setQueue((prev) =>
			prev.map((q) => (q.id === itemId ? { ...q, status: "uploading", progress: 0, error: null, recoverable: false } : q)),
		);
		try {
			const localError = validateLocal(item.file);
			if (localError) {
				throw new Error(localError);
			}
			const init = await initiateUpload(data.post.id, item.file);
			if (init.mode === "single") {
				await uploadSingle(init.uploadRecordId, item.file);
				setQueue((prev) => prev.map((q) => (q.id === itemId ? { ...q, progress: 1 } : q)));
			} else {
				const partSize = init.partSizeBytes || attachmentLimits.PART_SIZE_BYTES;
				await uploadMultipart(init.uploadRecordId, item.file, partSize, (p) => {
					setQueue((prev) => prev.map((q) => (q.id === itemId ? { ...q, progress: p } : q)));
				});
			}
			const nextQueue = queueRef.current.map((q) => (q.id === itemId ? { ...q, status: "done", progress: 1, error: null } : q));
			setQueue((prev) => prev.map((q) => (q.id === itemId ? { ...q, status: "done", progress: 1, error: null } : q)));
			if (nextQueue.length > 0 && nextQueue.every((q) => q.status === "done")) {
				window.location.reload();
			}
		} catch (e) {
			const normalized = normalizeUploadError(e);
			setQueue((prev) =>
				prev.map((q) =>
					q.id === itemId
						? { ...q, status: "error", progress: q.progress, error: normalized.message, recoverable: normalized.recoverable }
						: q,
				),
			);
		} finally {
			setBusy(false);
		}
	}

	async function retryCommentUploadItem(commentId: number, itemId: string) {
		const current = commentUploadsRef.current[commentId];
		if (!current || current.busy) return;
		const item = current.queue.find((q) => q.id === itemId);
		if (!item || item.status !== "error") return;
		updateCommentUploads(commentId, (c) => ({ ...c, error: null, busy: true }));
		updateCommentUploads(commentId, (c) => ({
			...c,
			queue: c.queue.map((q) => (q.id === itemId ? { ...q, status: "uploading", progress: 0, error: null, recoverable: false } : q)),
		}));
		try {
			const localError = validateLocal(item.file);
			if (localError) {
				throw new Error(localError);
			}
			const init = await initiateCommentUpload(commentId, item.file);
			if (init.mode === "single") {
				await uploadCommentSingle(init.uploadRecordId, item.file);
				updateCommentUploads(commentId, (c) => ({
					...c,
					queue: c.queue.map((q) => (q.id === itemId ? { ...q, progress: 1 } : q)),
				}));
			} else {
				const partSize = init.partSizeBytes || attachmentLimits.PART_SIZE_BYTES;
				await uploadCommentMultipart(init.uploadRecordId, item.file, partSize, (p) => {
					updateCommentUploads(commentId, (c) => ({
						...c,
						queue: c.queue.map((q) => (q.id === itemId ? { ...q, progress: p } : q)),
					}));
				});
			}
			const nextQueue = (commentUploadsRef.current[commentId]?.queue || []).map((q) =>
				q.id === itemId ? { ...q, status: "done", progress: 1, error: null } : q,
			);
			updateCommentUploads(commentId, (c) => ({
				...c,
				queue: c.queue.map((q) => (q.id === itemId ? { ...q, status: "done", progress: 1, error: null } : q)),
			}));
			if (nextQueue.length > 0 && nextQueue.every((q) => q.status === "done")) {
				window.location.reload();
			}
		} catch (e) {
			const normalized = normalizeUploadError(e);
			updateCommentUploads(commentId, (c) => ({
				...c,
				queue: c.queue.map((q) =>
					q.id === itemId ? { ...q, status: "error", error: normalized.message, recoverable: normalized.recoverable } : q,
				),
			}));
		} finally {
			updateCommentUploads(commentId, (c) => ({ ...c, busy: false }));
		}
	}

	async function initiateCommentUpload(commentId: number, file: File) {
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/comments/${commentId}/attachments/initiate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
			},
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!res.ok || !data?.ok) {
			throw new Error(String(data?.error || "创建上传任务失败"));
		}
		return data as {
			uploadRecordId: number;
			mode: "single" | "multipart";
			uploadId: string;
			partSizeBytes: number | null;
		};
	}

	async function listAlreadyUploadedCommentParts(uploadRecordId: number) {
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/comment-attachment-uploads/${uploadRecordId}/parts`,
			{ method: "GET" },
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!res.ok || !data?.ok || !Array.isArray(data?.parts)) {
			return new Set<number>();
		}
		return new Set<number>(data.parts.map((p: any) => Number(p)).filter((n: any) => Number.isFinite(n) && n > 0));
	}

	async function uploadCommentSingle(uploadRecordId: number, file: File) {
		const form = new FormData();
		form.append("file", file);
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/comment-attachment-uploads/${uploadRecordId}/upload`,
			{ method: "POST", body: form },
			{ timeoutMs: 300_000, retries: 3 },
		);
		if (!res.ok || !data?.ok) {
			throw new Error(String(data?.error || "上传失败"));
		}
	}

	async function uploadCommentMultipart(uploadRecordId: number, file: File, partSizeBytes: number, onProgress: (p: number) => void) {
		const totalParts = Math.ceil(file.size / partSizeBytes);
		const already = await listAlreadyUploadedCommentParts(uploadRecordId);
		let completed = 0;
		for (let i = 1; i <= totalParts; i++) {
			if (already.has(i)) completed++;
		}
		onProgress(totalParts > 0 ? completed / totalParts : 0);
		for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
			if (already.has(partNumber)) continue;
			const start = (partNumber - 1) * partSizeBytes;
			const end = Math.min(file.size, partNumber * partSizeBytes);
			const chunk = file.slice(start, end);
			const body = await chunk.arrayBuffer();
			const { res, data } = await fetchJsonWithRetry<any>(
				`/api/comment-attachment-uploads/${uploadRecordId}/parts/${partNumber}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body,
				},
				{ timeoutMs: 300_000, retries: 3 },
			);
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "上传分块失败"));
			}
			completed++;
			onProgress(totalParts > 0 ? completed / totalParts : 0);
		}
		const { res: doneRes, data: done } = await fetchJsonWithRetry<any>(
			`/api/comment-attachment-uploads/${uploadRecordId}/complete`,
			{ method: "POST" },
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!doneRes.ok || !done?.ok) {
			throw new Error(String(done?.error || "完成上传失败"));
		}
	}

	async function startCommentUpload(commentId: number, existingAttachments: CommentAttachmentRecord[]) {
		const current = commentUploads[commentId] || { selectedFiles: [], queue: [], busy: false, error: null };
		if (current.busy) return;
		const maxFilesPerComment = attachmentLimits.MAX_ATTACHMENTS_PER_COMMENT;
		const maxTotalCommentBytes = attachmentLimits.MAX_TOTAL_COMMENT_BYTES;
		const uploadingCount = current.queue.filter((q) => q.status === "pending" || q.status === "uploading").length;
		const remainingSlots = Math.max(0, maxFilesPerComment - existingAttachments.length - uploadingCount);
		if (remainingSlots <= 0) {
			updateCommentUploads(commentId, (c) => ({ ...c, error: "该评论附件数量已达上限" }));
			return;
		}
		if (current.selectedFiles.length === 0) {
			updateCommentUploads(commentId, (c) => ({ ...c, error: "请选择要上传的文件" }));
			return;
		}
		const existingBytes = existingAttachments.reduce((sum, a) => sum + (Number.isFinite(a.sizeBytes) ? a.sizeBytes : 0), 0);
		const uploadingBytes = current.queue
			.filter((q) => q.status === "pending" || q.status === "uploading")
			.reduce((sum, q) => sum + (Number.isFinite(q.file.size) ? q.file.size : 0), 0);
		const files = current.selectedFiles.slice(0, remainingSlots);
		const selectedBytes = files.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0);
		if (existingBytes + uploadingBytes + selectedBytes > maxTotalCommentBytes) {
			updateCommentUploads(commentId, (c) => ({
				...c,
				error: `已超出单条评论附件总大小上限（${formatSize(attachmentLimits.MAX_TOTAL_COMMENT_BYTES)}）`,
			}));
			return;
		}

		const items: UploadItem[] = files.map((file) => ({
			id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
			file,
			status: "pending",
			progress: 0,
			error: null,
			recoverable: false,
		}));
		updateCommentUploads(commentId, (c) => ({ ...c, queue: items, busy: true, error: null }));
		let hadError = false;
		for (const item of items) {
			updateCommentUploads(commentId, (c) => ({
				...c,
				queue: c.queue.map((q) => (q.id === item.id ? { ...q, status: "uploading", progress: 0, error: null } : q)),
			}));
			try {
				const localError = validateLocal(item.file);
				if (localError) {
					throw new Error(localError);
				}
				const init = await initiateCommentUpload(commentId, item.file);
				if (init.mode === "single") {
					await uploadCommentSingle(init.uploadRecordId, item.file);
					updateCommentUploads(commentId, (c) => ({
						...c,
						queue: c.queue.map((q) => (q.id === item.id ? { ...q, progress: 1 } : q)),
					}));
				} else {
					const partSize = init.partSizeBytes || attachmentLimits.PART_SIZE_BYTES;
					await uploadCommentMultipart(init.uploadRecordId, item.file, partSize, (p) => {
						updateCommentUploads(commentId, (c) => ({
							...c,
							queue: c.queue.map((q) => (q.id === item.id ? { ...q, progress: p } : q)),
						}));
					});
				}
				updateCommentUploads(commentId, (c) => ({
					...c,
					queue: c.queue.map((q) => (q.id === item.id ? { ...q, status: "done", progress: 1 } : q)),
				}));
			} catch (e) {
				hadError = true;
				const normalized = normalizeUploadError(e);
				updateCommentUploads(commentId, (c) => ({
					...c,
					queue: c.queue.map((q) =>
						q.id === item.id ? { ...q, status: "error", error: normalized.message, recoverable: normalized.recoverable } : q,
					),
				}));
			}
		}
		updateCommentUploads(commentId, (c) => ({ ...c, busy: false, selectedFiles: [] }));
		if (!hadError) {
			window.location.reload();
		}
	}

	async function initiateUpload(postId: number, file: File) {
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/posts/${postId}/attachments/initiate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
			},
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!res.ok || !data?.ok) {
			throw new Error(String(data?.error || "创建上传任务失败"));
		}
		return data as {
			uploadRecordId: number;
			mode: "single" | "multipart";
			uploadId: string;
			partSizeBytes: number | null;
		};
	}

	async function listAlreadyUploadedParts(uploadRecordId: number) {
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/attachment-uploads/${uploadRecordId}/parts`,
			{ method: "GET" },
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!res.ok || !data?.ok || !Array.isArray(data?.parts)) {
			return new Set<number>();
		}
		return new Set<number>(data.parts.map((p: any) => Number(p)).filter((n: any) => Number.isFinite(n) && n > 0));
	}

	async function uploadSingle(uploadRecordId: number, file: File) {
		const form = new FormData();
		form.append("file", file);
		const { res, data } = await fetchJsonWithRetry<any>(
			`/api/attachment-uploads/${uploadRecordId}/upload`,
			{ method: "POST", body: form },
			{ timeoutMs: 300_000, retries: 3 },
		);
		if (!res.ok || !data?.ok) {
			throw new Error(String(data?.error || "上传失败"));
		}
	}

	async function uploadMultipart(uploadRecordId: number, file: File, partSizeBytes: number, onProgress: (p: number) => void) {
		const totalParts = Math.ceil(file.size / partSizeBytes);
		const already = await listAlreadyUploadedParts(uploadRecordId);
		let completed = 0;
		for (let i = 1; i <= totalParts; i++) {
			if (already.has(i)) completed++;
		}
		onProgress(totalParts > 0 ? completed / totalParts : 0);
		for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
			if (already.has(partNumber)) {
				continue;
			}
			const start = (partNumber - 1) * partSizeBytes;
			const end = Math.min(file.size, partNumber * partSizeBytes);
			const chunk = file.slice(start, end);
			const body = await chunk.arrayBuffer();
			const { res, data } = await fetchJsonWithRetry<any>(
				`/api/attachment-uploads/${uploadRecordId}/parts/${partNumber}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body,
				},
				{ timeoutMs: 300_000, retries: 3 },
			);
			if (!res.ok || !data?.ok) {
				throw new Error(String(data?.error || "上传分块失败"));
			}
			completed++;
			onProgress(totalParts > 0 ? completed / totalParts : 0);
		}
		const { res: doneRes, data: done } = await fetchJsonWithRetry<any>(
			`/api/attachment-uploads/${uploadRecordId}/complete`,
			{ method: "POST" },
			{ timeoutMs: 15_000, retries: 3 },
		);
		if (!doneRes.ok || !done?.ok) {
			throw new Error(String(done?.error || "完成上传失败"));
		}
	}

	async function startUpload() {
		if (!canUpload) {
			if (canManageAttachments && uploadsPaused) {
				setGlobalError(uploadsPausedMessage);
			}
			return;
		}
		setGlobalError(null);
		if (selectedFiles.length === 0) {
			setGlobalError("请选择要上传的文件");
			return;
		}
		if (selectionSize.overLimit) {
			setGlobalError(`已超出单帖附件总大小上限（${formatSize(attachmentLimits.MAX_TOTAL_POST_BYTES)}）`);
			return;
		}
		if (remainingSlots <= 0) {
			setGlobalError("该帖子附件数量已达上限");
			return;
		}
		const files = effectiveSelectedFiles;
		const items: UploadItem[] = files.map((file) => ({
			id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
			file,
			status: "pending",
			progress: 0,
			error: null,
			recoverable: false,
		}));
		setQueue(items);
		setBusy(true);
		let hadError = false;
		for (const item of items) {
			setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "uploading", progress: 0 } : q)));
			try {
				const localError = validateLocal(item.file);
				if (localError) {
					throw new Error(localError);
				}
				const init = await initiateUpload(data.post.id, item.file);
				if (init.mode === "single") {
					await uploadSingle(init.uploadRecordId, item.file);
					setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, progress: 1 } : q)));
				} else {
					const partSize = init.partSizeBytes || attachmentLimits.PART_SIZE_BYTES;
					await uploadMultipart(init.uploadRecordId, item.file, partSize, (p) => {
						setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, progress: p } : q)));
					});
				}
				setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "done", progress: 1 } : q)));
			} catch (e) {
				hadError = true;
				const normalized = normalizeUploadError(e);
				setQueue((prev) =>
					prev.map((q) =>
						q.id === item.id ? { ...q, status: "error", error: normalized.message, recoverable: normalized.recoverable } : q,
					),
				);
			}
		}
		setBusy(false);
		setSelectedFiles([]);
		if (!hadError) {
			window.location.reload();
		}
	}

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex items-center justify-between">
					<div>
						<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
							{data.post.title}
						</h1>
						<p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
							<span>作者：{data.post.authorName}</span>
							{postPinned ? (
								<span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
									置顶
								</span>
							) : null}
							{postBanned ? (
								<span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-200">
									已封禁
								</span>
							) : null}
							<span className="ml-3">
								发布时间：{new Date(data.post.createdAt).toLocaleString()}
							</span>
							<span className="ml-3">评论：{data.commentCount}</span>
							<span className="ml-3">点赞：{data.likeCount}</span>
						</p>
					</div>
				</header>
				<main className="flex flex-col gap-6">
					{postBanned ? (
						<div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
							<div className="font-medium">该帖子已被封禁，禁止跟帖回复</div>
							{data.post.bannedReason ? <div className="mt-1">封禁原因：{data.post.bannedReason}</div> : null}
						</div>
					) : null}
					{isBanned ? (
						<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
							账号已被封禁，无法删帖、点赞或发表评论。
						</div>
					) : null}
					{globalError ? (
						<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
							{globalError}
						</div>
					) : null}
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<div className="mb-4 flex items-center justify-between gap-3">
							<Link
								to="/posts"
								className="text-sm text-blue-600 hover:underline dark:text-blue-400"
							>
								返回列表
							</Link>
							<div className="flex items-center gap-2">
								{data.user && data.user.id === data.post.authorId ? (
									isBanned ? (
										<button
											type="button"
											disabled
											className="cursor-not-allowed rounded bg-gray-300 px-3 py-1 text-sm font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
										>
											删帖
										</button>
									) : (
										<Form method="post">
											<input type="hidden" name="intent" value="delete" />
											<button
												type="submit"
												className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
											>
												删帖
											</button>
										</Form>
									)
								) : null}
								{data.user ? (
									data.user.id !== data.post.authorId ? (
										isBanned ? (
											<button
												type="button"
												disabled
												className="cursor-not-allowed rounded bg-gray-300 px-3 py-1 text-sm font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
											>
												点赞
											</button>
										) : (
											<Form method="post">
												<input type="hidden" name="intent" value="toggleLike" />
												<button
													type="submit"
													className={
														data.likedByMe
															? "rounded bg-gray-800 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
															: "rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
													}
												>
													{data.likedByMe ? "已赞" : "点赞"}
												</button>
											</Form>
										)
									) : (
										<button
											type="button"
											disabled
											className="cursor-not-allowed rounded bg-gray-300 px-3 py-1 text-sm font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
										>
											点赞
										</button>
									)
								) : (
									<a
										href="/login"
										className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
									>
										登录后点赞
									</a>
								)}
							</div>
						</div>
						{actionData?.formError ? (
							<p className="mb-3 text-sm text-red-600">{actionData.formError}</p>
						) : null}
						{isAdminUser ? (
							<div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-700 dark:bg-gray-900/30">
								<div className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">管理操作</div>
								<div className="flex flex-col gap-3">
									{postBanned ? (
										<div className="flex flex-wrap items-center gap-2">
											{isSuperadminUser ? (
												<Form method="post">
													<input type="hidden" name="intent" value="unbanPost" />
													<button
														type="submit"
														className="rounded bg-gray-800 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
													>
														解封帖子
													</button>
												</Form>
											) : (
												<span className="text-xs text-gray-500 dark:text-gray-400">只有超级管理员可以解封</span>
											)}
											{isSuperadminUser ? (
												<Form
													method="post"
													onSubmit={(e) => {
														const ok = window.confirm("确认永久删除该封禁帖子吗？此操作不可恢复。\n\n删除后将同时删除该帖的评论、点赞与附件。");
														if (!ok) e.preventDefault();
													}}
												>
													<input type="hidden" name="intent" value="deleteBannedPost" />
													<button type="submit" className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700">
														永久删除
													</button>
												</Form>
											) : null}
										</div>
									) : (
										<Form
											method="post"
											onSubmit={(e) => {
												const ok = window.confirm("确认封禁该帖子吗？封禁后所有用户将无法跟帖回复。\n\n如为管理员操作，将自动通知超级管理员备案。");
												if (!ok) e.preventDefault();
											}}
											className="flex flex-col gap-2 sm:flex-row sm:items-end"
										>
											<input type="hidden" name="intent" value="banPost" />
											<div className="flex-1">
												<label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">封禁原因</label>
												<input
													name="reason"
													maxLength={200}
													className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
													placeholder="请输入封禁原因（必填）"
												/>
											</div>
											<button type="submit" className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
												封禁帖子
											</button>
										</Form>
									)}
									{isSuperadminUser ? (
										<div className="flex flex-wrap items-center gap-2">
											<Form method="post">
												<input type="hidden" name="intent" value="setPin" />
												<input type="hidden" name="mode" value="off" />
												<button
													type="submit"
													disabled={!postPinned}
													className="rounded bg-gray-800 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-60 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
												>
													取消置顶
												</button>
											</Form>
											<Form method="post">
												<input type="hidden" name="intent" value="setPin" />
												<input type="hidden" name="mode" value="1d" />
												<button type="submit" className="rounded bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700">
													置顶1天
												</button>
											</Form>
											<Form method="post">
												<input type="hidden" name="intent" value="setPin" />
												<input type="hidden" name="mode" value="7d" />
												<button type="submit" className="rounded bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700">
													置顶7天
												</button>
											</Form>
											<Form method="post">
												<input type="hidden" name="intent" value="setPin" />
												<input type="hidden" name="mode" value="permanent" />
												<button type="submit" className="rounded bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700">
													永久置顶
												</button>
											</Form>
										</div>
									) : null}
								</div>
							</div>
						) : null}
						<div className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800 dark:text-gray-100">
							{data.post.content}
						</div>
					</section>
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<div className="mb-4 flex items-center justify-between gap-3">
							<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
								附件（{attachments.length} / {attachmentLimits.MAX_ATTACHMENTS_PER_POST}）
							</h2>
							<span className="text-xs text-gray-500 dark:text-gray-400">
								单附件大小：{formatSize(attachmentLimits.MIN_FILE_SIZE_BYTES)}~{formatSize(attachmentLimits.MAX_FILE_SIZE_BYTES)}
							</span>
						</div>
						{attachments.length === 0 ? (
							<p className="text-sm text-gray-600 dark:text-gray-300">暂无附件。</p>
						) : (
							<div className="space-y-3">
								{canManageAttachments ? (
									<div className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-900/30">
										<div className="flex items-center gap-3">
											<button
												type="button"
												onClick={() => {
													if (selectedAttachmentIds.length === attachments.length) {
														setSelectedAttachmentIds([]);
													} else {
														setSelectedAttachmentIds(attachments.map((a) => a.id));
													}
											}}
											className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-900 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
										>
											{selectedAttachmentIds.length === attachments.length ? "清空选择" : "全选"}
										</button>
										<span className="text-gray-600 dark:text-gray-300">已选 {selectedAttachmentIds.length} 个</span>
									</div>
									<button
										type="button"
										onClick={() => deletePostAttachments(selectedAttachmentIds)}
										disabled={selectedAttachmentIds.length === 0}
										className="rounded bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-60"
									>
										删除所选
									</button>
								</div>
								) : null}
								<ul className="space-y-2">
									{attachments.map((a) => (
										<li
											key={a.id}
											className={
												deletingPostAttachmentIds[a.id]
													? "flex items-start justify-between gap-3 rounded border border-gray-200 px-3 py-2 text-sm opacity-60 transition-opacity dark:border-gray-700"
													: "flex items-start justify-between gap-3 rounded border border-gray-200 px-3 py-2 text-sm transition-opacity dark:border-gray-700"
											}
										>
											<div className="flex min-w-0 items-start gap-3">
												{canManageAttachments ? (
													<input
														type="checkbox"
														checked={selectedAttachmentIds.includes(a.id)}
														onChange={() => toggleSelectedAttachment(a.id)}
														className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600"
													/>
												) : null}
												<div className="min-w-0">
													<div className="truncate font-medium text-gray-900 dark:text-gray-100">{a.filename}</div>
													<div className="text-xs text-gray-500 dark:text-gray-400">
														{formatSize(a.sizeBytes)} · {new Date(a.createdAt).toLocaleString()}
													</div>
												</div>
											</div>
											<div className="flex shrink-0 items-center gap-2">
												{data.user ? (
													<button
														type="button"
														onClick={() => requestDownload(a.id)}
														disabled={isBanned}
													className={
														isBanned
															? "cursor-not-allowed rounded bg-gray-300 px-3 py-1 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
															: "rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
													}
												>
													下载
												</button>
												) : (
													<a
														href="/login"
														className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
													>
														登录后下载
													</a>
												)}
												{canManageAttachments ? (
													<button
														type="button"
														onClick={() => deletePostAttachments([a.id])}
													disabled={Boolean(deletingPostAttachmentIds[a.id])}
													className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-70"
												>
													{deletingPostAttachmentIds[a.id] ? "删除中..." : "删除"}
												</button>
											) : null}
											</div>
										</li>
									))}
								</ul>
							</div>
						)}

					{canManageAttachments ? (
						<div className="mt-6 rounded border border-gray-200 p-4 dark:border-gray-700">
							<div className="flex flex-col gap-3">
								<div className="flex items-center justify-between gap-3">
									<div className="min-w-0">
										<label className="text-sm font-medium text-gray-900 dark:text-gray-100">
											上传附件
										</label>
										<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
										<span>剩余可上传：{remainingSlots} 个</span>
											<span>
												已选 {formatSize(selectionSize.selectedBytes)} / 剩余 {formatSize(selectionSize.remainingBytes)}
											</span>
											{selectedFiles.length > remainingSlots ? (
												<span className="text-amber-700 dark:text-amber-300">
													已选择 {selectedFiles.length} 个，仅上传前 {remainingSlots} 个
												</span>
											) : null}
											{selectionSize.overLimit ? (
												<span className="text-red-600 dark:text-red-300">
													已超出 {formatSize(attachmentLimits.MAX_TOTAL_POST_BYTES)} 上限
												</span>
											) : null}
										</div>
									</div>
									<button
										type="button"
										onClick={() => fileInputRef.current?.click()}
										disabled={busy || remainingSlots <= 0 || uploadsPaused}
										className={
											busy || remainingSlots <= 0 || uploadsPaused
												? "h-9 w-12 cursor-not-allowed rounded bg-gray-300 text-[10px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200"
												: "h-9 w-12 rounded bg-gradient-to-r from-blue-600 to-cyan-500 text-[10px] font-semibold text-white shadow hover:from-blue-700 hover:to-cyan-600"
										}
									>
										<span className="block leading-3">
											上传
											<br />
											附件
										</span>
									</button>
								</div>
							{uploadsPaused ? (
								<div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
									{uploadsPausedMessage}
								</div>
							) : null}
							<input
								ref={fileInputRef}
								type="file"
								multiple
								disabled={busy || remainingSlots <= 0 || uploadsPaused}
								onChange={(e) => {
									const files = Array.from(e.target.files || []);
									setSelectedFiles(files);
									e.currentTarget.value = "";
								}}
								className="hidden"
							/>
							<div
								onDragEnter={(e) => {
									e.preventDefault();
								if (busy || remainingSlots <= 0 || uploadsPaused) return;
								setIsDragging(true);
							}}
								onDragOver={(e) => {
									e.preventDefault();
								if (busy || remainingSlots <= 0 || uploadsPaused) return;
								setIsDragging(true);
							}}
								onDragLeave={(e) => {
									e.preventDefault();
								setIsDragging(false);
							}}
								onDrop={(e) => {
									e.preventDefault();
								setIsDragging(false);
								if (busy || remainingSlots <= 0 || uploadsPaused) return;
								const files = Array.from(e.dataTransfer.files || []);
								setSelectedFiles(files);
							}}
							className={
								busy || remainingSlots <= 0 || uploadsPaused
									? "rounded-lg border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-400 dark:border-gray-800 dark:bg-gray-900/30 dark:text-gray-500"
									: isDragging
										? "cursor-pointer rounded-lg border border-dashed border-blue-400 bg-blue-50 p-4 text-sm text-blue-700 dark:border-blue-600 dark:bg-blue-900/20 dark:text-blue-200"
										: "cursor-pointer rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-700 hover:border-blue-400 hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-200 dark:hover:border-blue-600 dark:hover:bg-blue-900/20"
							}
							onClick={() => {
								if (busy || remainingSlots <= 0 || uploadsPaused) return;
								fileInputRef.current?.click();
							}}
							role="button"
							tabIndex={0}
							onKeyDown={(e) => {
								if (e.key !== "Enter" && e.key !== " ") return;
								e.preventDefault();
								if (busy || remainingSlots <= 0 || uploadsPaused) return;
								fileInputRef.current?.click();
							}}
						>
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="font-medium">
										拖拽文件到此处，或点击选择文件
									</div>
											<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
												单帖总大小上限 {formatSize(maxTotalPostBytes)}；大文件将自动分块上传
											</div>
										</div>
										<div className="text-xs text-gray-500 dark:text-gray-400">
											{formatSize(attachmentLimits.MIN_FILE_SIZE_BYTES)}~{formatSize(maxFileSizeBytesForUser)}
										</div>
									</div>
							{effectiveSelectedFiles.length > 0 ? (
								<ul className="mt-3 space-y-1 text-xs text-gray-700 dark:text-gray-200">
									{effectiveSelectedFiles.map((f) => (
										<li key={f.name} className="flex items-center justify-between gap-3">
											<span className="min-w-0 truncate">{f.name}</span>
											<span className="shrink-0 text-gray-500 dark:text-gray-400">
												{formatSize(f.size)}
												{f.type ? ` · ${f.type}` : ""}
											</span>
										</li>
									))}
								</ul>
							) : null}
						</div>
								<div className="flex items-center justify-between">
										<span className="text-xs text-gray-500 dark:text-gray-400">每帖最多 {maxFilesPerPost} 个附件</span>
									<button
										type="button"
										onClick={startUpload}
										disabled={busy || effectiveSelectedFiles.length === 0 || remainingSlots <= 0 || uploadsPaused || selectionSize.overLimit}
										className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
									>
										{busy ? "上传中..." : "开始上传"}
									</button>
								</div>

						{queue.length > 0 ? (
							<ul className="mt-2 space-y-2">
								{queue.map((q) => (
									<li key={q.id} className="rounded bg-gray-50 px-3 py-2 text-sm dark:bg-gray-900/30">
										<div className="flex items-center justify-between gap-3">
											<span className="truncate text-gray-900 dark:text-gray-100">{q.file.name}</span>
											<span className="text-xs text-gray-500 dark:text-gray-400">{formatSize(q.file.size)}</span>
										</div>
										<div className="mt-2 h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
											<div
												className={q.status === "error" ? "h-2 bg-red-500" : "h-2 bg-blue-600"}
												style={{ width: `${Math.round(q.progress * 100)}%` }}
											/>
										</div>
										<div className="mt-1 flex items-center justify-between text-xs">
											<span className="text-gray-600 dark:text-gray-300">
												{q.status === "pending"
													? "等待上传"
													: q.status === "uploading"
														? "上传中"
													: q.status === "done"
														? "已完成"
														: "失败"}
											</span>
											<span className="text-gray-500 dark:text-gray-400">{Math.round(q.progress * 100)}%</span>
										</div>
										{q.error ? (
											<div className="mt-2 flex items-start justify-between gap-3 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
												<span className="min-w-0 flex-1 break-words">{q.error}</span>
												{q.status === "error" && q.recoverable ? (
													<button
														type="button"
														onClick={() => retryUploadItem(q.id)}
														disabled={busy}
														className="shrink-0 rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-70"
													>
														重试
													</button>
												) : null}
											</div>
										) : null}
									</li>
								))}
							</ul>
						) : null}
								</div>
							</div>
						) : null}
					</section>
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
							评论（{data.commentCount}）
						</h2>
						{comments.length === 0 ? (
							<p className="text-sm text-gray-600 dark:text-gray-300">
								还没有任何评论。
							</p>
						) : (
							<ul className="space-y-4">
								{comments.map((comment, index) => (
									<li key={comment.id} className="border-b border-gray-200 pb-3 last:border-none last:pb-0 dark:border-gray-700">
										<div className="mb-1 flex items-center justify-between">
											<span className="text-xs text-gray-500 dark:text-gray-400">
												{commentStartIndex + index + 1} 楼
											</span>
											<span className="text-xs text-gray-500 dark:text-gray-400">
												{new Date(comment.createdAt).toLocaleString()}
											</span>
										</div>
										<div className="text-sm text-gray-800 dark:text-gray-100">
											{comment.content}
										</div>
										<p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
											<span>作者：{comment.authorName}</span>
										</p>
										{comment.attachments.length === 0 ? null : (
											<ul className="mt-3 space-y-2">
												{comment.attachments.map((a) => (
													<li
														key={a.id}
														className={
															deletingCommentAttachmentIds[a.id]
																? "flex items-center justify-between gap-3 rounded border border-gray-200 px-3 py-2 text-xs opacity-60 transition-opacity dark:border-gray-700"
																: "flex items-center justify-between gap-3 rounded border border-gray-200 px-3 py-2 text-xs transition-opacity dark:border-gray-700"
														}
													>
														<div className="flex min-w-0 items-start gap-2">
															{data.user && data.user.id === comment.authorId && !isBanned ? (
																<input
																	type="checkbox"
																	checked={(commentSelectedAttachmentIds[comment.id] || []).includes(a.id)}
																	onChange={() => toggleSelectedCommentAttachment(comment.id, a.id)}
																	disabled={Boolean(deletingCommentAttachmentIds[a.id])}
																	className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600"
																/>
															) : null}
															<div className="min-w-0">
																<div className="truncate font-medium text-gray-900 dark:text-gray-100">{a.filename}</div>
																<div className="text-[11px] text-gray-500 dark:text-gray-400">
																	{formatSize(a.sizeBytes)} · {new Date(a.createdAt).toLocaleString()}
																</div>
															</div>
														</div>
														{data.user ? (
															<div className="flex items-center gap-2">
																<button
																	type="button"
																	onClick={() => requestCommentDownload(a.id)}
																	disabled={isBanned}
																	className={
																		isBanned
																			? "cursor-not-allowed rounded bg-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
																			: "rounded bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
																	}
																>
																	下载
																</button>
																{data.user.id === comment.authorId && !isBanned ? (
																	<button
																		type="button"
																		onClick={() => deleteCommentAttachments(comment.id, [a.id])}
																	disabled={Boolean(deletingCommentAttachmentIds[a.id])}
																	className="rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-70"
																	>
																	{deletingCommentAttachmentIds[a.id] ? "删除中..." : "删除"}
																</button>
															) : null}
														</div>
													) : (
														<a
															href="/login"
															className="rounded bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
														>
															登录后下载
														</a>
													)}
												</li>
											))}
										</ul>
									)}

										{data.user && data.user.id === comment.authorId && !isBanned && comment.attachments.length > 0 ? (
											<div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs">
												<button
													type="button"
													onClick={() => {
														const current = commentSelectedAttachmentIds[comment.id] || [];
														if (current.length === comment.attachments.length) {
															setCommentSelectedAttachmentIds((prev) => ({ ...prev, [comment.id]: [] }));
														} else {
															setCommentSelectedAttachmentIds((prev) => ({ ...prev, [comment.id]: comment.attachments.map((a) => a.id) }));
														}
												}}
												className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
											>
												{(commentSelectedAttachmentIds[comment.id] || []).length === comment.attachments.length ? "清空选择" : "全选"}
											</button>
											<button
												type="button"
												onClick={() => deleteCommentAttachments(comment.id, commentSelectedAttachmentIds[comment.id] || [])}
												disabled={(() => {
													const selected = commentSelectedAttachmentIds[comment.id] || [];
													if (!selected.length) return true;
													return selected.some((id) => Boolean(deletingCommentAttachmentIds[id]));
											})()}
												className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-60"
											>
												{(() => {
													const selected = commentSelectedAttachmentIds[comment.id] || [];
													const deleting = selected.some((id) => Boolean(deletingCommentAttachmentIds[id]));
													return deleting ? "删除中..." : "删除所选";
											})()}
											</button>
										</div>
									) : null}

										{data.user && data.user.id === comment.authorId && !isBanned ? (
											<div className="mt-3 rounded border border-gray-200 p-3 dark:border-gray-700">
												<div className="flex items-center justify-between gap-3">
													<div className="min-w-0">
														<div className="text-sm font-medium text-gray-900 dark:text-gray-100">上传评论附件</div>
												<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
											剩余可上传：
											{(() => {
												const maxFilesPerComment = attachmentLimits.MAX_ATTACHMENTS_PER_COMMENT;
												const uploading =
													commentUploads[comment.id]?.queue.filter((q) => q.status === "pending" || q.status === "uploading")
														.length || 0;
												const remaining = Math.max(0, maxFilesPerComment - comment.attachments.length - uploading);
												return String(remaining);
											})()}
											个；单条评论总大小上限 {formatSize(attachmentLimits.MAX_TOTAL_COMMENT_BYTES)}
												</div>
													</div>
													<button
														type="button"
														onClick={() => startCommentUpload(comment.id, comment.attachments)}
														disabled={Boolean(commentUploads[comment.id]?.busy)}
														className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-70"
													>
														{commentUploads[comment.id]?.busy ? "上传中..." : "开始上传"}
													</button>
												</div>
													<div className="mt-2 flex items-center justify-between gap-3">
														<input
															type="file"
															multiple
															disabled={Boolean(commentUploads[comment.id]?.busy)}
															onChange={(e) => {
																const files = Array.from(e.target.files || []);
																updateCommentUploads(comment.id, (c) => ({ ...c, selectedFiles: files, error: null }));
																e.currentTarget.value = "";
														}}
															className="block w-full text-xs text-gray-700 file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1 file:text-xs file:font-medium file:text-gray-900 hover:file:bg-gray-200 dark:text-gray-200 dark:file:bg-gray-800 dark:file:text-gray-100 dark:hover:file:bg-gray-700"
														/>
													</div>
													{(() => {
														const state = commentUploads[comment.id] || { selectedFiles: [], queue: [], busy: false, error: null };
														const uploadingCount = state.queue.filter((q) => q.status === "pending" || q.status === "uploading").length;
													const maxFilesPerComment = attachmentLimits.MAX_ATTACHMENTS_PER_COMMENT;
													const maxTotalCommentBytes = attachmentLimits.MAX_TOTAL_COMMENT_BYTES;
														const remaining = Math.max(0, maxFilesPerComment - comment.attachments.length - uploadingCount);
														const effective = state.selectedFiles.slice(0, remaining);
														const existingBytes = comment.attachments.reduce((sum, a) => sum + (Number.isFinite(a.sizeBytes) ? a.sizeBytes : 0), 0);
														const uploadingBytes = state.queue
															.filter((q) => q.status === "pending" || q.status === "uploading")
															.reduce((sum, q) => sum + (Number.isFinite(q.file.size) ? q.file.size : 0), 0);
														const selectedBytes = effective.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0);
													const remainingBytes = Math.max(0, maxTotalCommentBytes - existingBytes - uploadingBytes);
													const overLimit = selectedBytes > remainingBytes;
														return (
															<>
																<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
																	<span>
																		已选 {formatSize(selectedBytes)} / 剩余 {formatSize(remainingBytes)}
																	</span>
																	{state.selectedFiles.length > remaining ? (
																		<span className="text-amber-700 dark:text-amber-300">
																			已选择 {state.selectedFiles.length} 个，仅上传前 {remaining} 个
																		</span>
																	) : null}
																{overLimit ? (
																	<span className="text-red-600 dark:text-red-300">
																		已超出 {formatSize(attachmentLimits.MAX_TOTAL_COMMENT_BYTES)} 上限
																	</span>
																) : null}
															</div>
																{effective.length > 0 ? (
																	<ul className="mt-2 space-y-1 text-xs text-gray-700 dark:text-gray-200">
																		{effective.map((f) => (
																			<li key={f.name} className="flex items-center justify-between gap-3">
																				<span className="min-w-0 truncate">{f.name}</span>
																				<span className="shrink-0 text-gray-500 dark:text-gray-400">
																					{formatSize(f.size)}
																					{f.type ? ` · ${f.type}` : ""}
																				</span>
																			</li>
																		))}
																	</ul>
																) : null}
																{commentUploads[comment.id]?.error ? (
																	<div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
																		{commentUploads[comment.id]?.error}
																	</div>
																) : null}
															</>
														);
													})()}
													{commentUploads[comment.id]?.queue?.length ? (
														<ul className="mt-2 space-y-2">
															{commentUploads[comment.id].queue.map((q) => (
																<li key={q.id} className="rounded bg-gray-50 px-3 py-2 text-xs dark:bg-gray-900/30">
																<div className="flex items-center justify-between gap-3">
																	<span className="min-w-0 truncate text-gray-900 dark:text-gray-100">{q.file.name}</span>
																	<span className="shrink-0 text-gray-500 dark:text-gray-400">{formatSize(q.file.size)}</span>
																</div>
																<div className="mt-2 h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
																	<div
																		className={q.status === "error" ? "h-2 bg-red-500" : "h-2 bg-blue-600"}
																		style={{ width: `${Math.round(q.progress * 100)}%` }}
																	/>
																</div>
																	<div className="mt-1 flex items-center justify-between text-[11px]">
																	<span className="text-gray-600 dark:text-gray-300">
																		{q.status === "pending"
																			? "等待上传"
																			: q.status === "uploading"
																				? "上传中"
																				: q.status === "done"
																					? "已完成"
																					: "失败"}
																	</span>
																	<span className="text-gray-500 dark:text-gray-400">{Math.round(q.progress * 100)}%</span>
																</div>
																	{q.error ? (
																		<div className="mt-2 flex items-start justify-between gap-3 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
																			<span className="min-w-0 flex-1 break-words">{q.error}</span>
																			{q.status === "error" && q.recoverable ? (
																				<button
																					type="button"
																					onClick={() => retryCommentUploadItem(comment.id, q.id)}
																					disabled={Boolean(commentUploads[comment.id]?.busy)}
																					className="shrink-0 rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-70"
																				>
																					重试
																				</button>
																			) : null}
																		</div>
																	) : null}
																</li>
															))}
														</ul>
													) : null}
											</div>
										) : null}
									</li>
								))}
							</ul>
						)}
						<div className="mt-6 flex items-center justify-between text-sm">
							<div className="text-gray-600 dark:text-gray-300">
								第 {data.page} / {data.totalPages} 页
							</div>
							<div className="flex items-center gap-3">
								{canPrev ? (
									<Link
										to={`?page=${data.page - 1}`}
										className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									>
										上一页
									</Link>
								) : (
									<span className="rounded border border-gray-200 px-3 py-1 text-gray-400 dark:border-gray-800 dark:text-gray-500">
										上一页
									</span>
								)}
								{canNext ? (
									<Link
										to={`?page=${data.page + 1}`}
										className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									>
										下一页
									</Link>
								) : (
									<span className="rounded border border-gray-200 px-3 py-1 text-gray-400 dark:border-gray-800 dark:text-gray-500">
										下一页
									</span>
								)}
							</div>
						</div>
					</section>
					<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
						<h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
							发表评论
						</h2>
						{data.user ? (
							isBanned ? (
								<p className="text-sm text-gray-600 dark:text-gray-300">
									当前账号已被封禁，无法发表评论。
								</p>
							) : postBanned ? (
								<p className="text-sm text-gray-600 dark:text-gray-300">该帖子已封禁，禁止跟帖回复。</p>
							) : (
							<Form method="post" className="space-y-4">
								<input type="hidden" name="intent" value="comment" />
								<div>
									<textarea
										name="content"
										rows={4}
										className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
									/>
									{actionData?.fieldErrors?.content ? (
										<p className="mt-1 text-xs text-red-600">
											{actionData.fieldErrors.content}
										</p>
									) : null}
								</div>
								{actionData?.formError ? (
									<p className="text-sm text-red-600">{actionData.formError}</p>
								) : null}
								<div className="flex items-center justify-between">
									<span className="text-xs text-gray-500 dark:text-gray-400">
										当前第 {data.page} 页发表评论会刷新当前页
									</span>
									<button
										type="submit"
										disabled={isSubmitting}
										className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
									>
										{isSubmitting ? "提交中..." : "提交评论"}
									</button>
								</div>
							</Form>
							)
						) : (
							<p className="text-sm text-gray-600 dark:text-gray-300">
								登录后可以发表评论。
							</p>
						)}
					</section>
				</main>
			</div>
		</div>
	);
}
