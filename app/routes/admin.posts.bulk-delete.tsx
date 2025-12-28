import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { assertNotBanned, getClientIp, isSuperadmin, requireUser, verifyLogin } from "~/lib/auth.server";
import { removeAllAttachmentsForPost, removeAllCommentAttachmentUploadsForComments, removeAllCommentAttachmentsForComments, removeAllCommentAttachmentsForPost } from "~/lib/attachments.server";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";
import { removeAllPostImagesForPost } from "~/lib/post-images.server";

type BannedPostRow = {
	id: number;
	title: string;
	authorId: number;
	authorName: string | null;
	createdAt: number;
	bannedAt: number | null;
	bannedBy: number | null;
	bannedByName: string | null;
	bannedReason: string | null;
	commentCount: number;
	attachmentCount: number;
	commentAttachmentCount: number;
	imageCount: number;
};

type ShieldedCommentRow = {
	id: number;
	postId: number;
	postTitle: string;
	authorId: number;
	authorName: string | null;
	content: string;
	createdAt: number;
	shieldedAt: number | null;
	shieldedBy: number | null;
	shieldedByName: string | null;
	shieldReason: string | null;
};

type Paged<T> = {
	items: T[];
	page: number;
	pageSize: number;
	totalCount: number;
	totalPages: number;
};

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	bannedPosts: Paged<BannedPostRow>;
	shieldedComments: Paged<ShieldedCommentRow>;
};

type ActionData =
	| { ok: true; intent: "hardDeleteBannedPosts"; deletedCount: number; deletedIds: number[] }
	| { ok: true; intent: "hardDeleteShieldedComments"; deletedCount: number; deletedIds: number[] }
	| {
			ok: true;
			intent: "bulkBanUsersFromShieldedComments";
			bannedCount: number;
			bannedUserIds: number[];
			alreadyBannedUserIds: number[];
			skipped: { userId: number; reason: string }[];
	  }
	| { ok: false; error: string };

function parsePositiveInt(value: string | null, fallback: number) {
	if (!value) return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}

function getSelectedIds(formData: FormData, key: string) {
	const ids = formData
		.getAll(key)
		.map((v) => Number(v))
		.filter((n) => Number.isFinite(n) && n > 0)
		.map((n) => Math.floor(n));
	return Array.from(new Set(ids));
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (!isSuperadmin(me)) {
		throw new Response("只有超级管理员或站点管理员可访问", { status: 403 });
	}

	const url = new URL(request.url);
	const postsPageSize = 20;
	const commentsPageSize = 20;
	const requestedPostsPage = parsePositiveInt(url.searchParams.get("postsPage"), 1);
	const requestedCommentsPage = parsePositiveInt(url.searchParams.get("commentsPage"), 1);
	const db = getDBFromContext(context);

	const bannedPostCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM posts WHERE is_banned = 1 AND deleted_at IS NULL",
	);
	const bannedPostTotalCount = Number(bannedPostCountRow?.count ?? 0);
	const bannedPostTotalPages = Math.max(1, Math.ceil(bannedPostTotalCount / postsPageSize));
	const postsPage = Math.min(requestedPostsPage, bannedPostTotalPages);
	const postsOffset = (postsPage - 1) * postsPageSize;

	const bannedPosts = await queryAll<BannedPostRow>(
		db,
		"SELECT p.id as id, p.title as title, p.author_id as authorId, au.display_name as authorName, p.created_at as createdAt, p.banned_at as bannedAt, p.banned_by as bannedBy, bu.display_name as bannedByName, p.banned_reason as bannedReason, (SELECT COUNT(1) FROM comments c WHERE c.post_id = p.id) as commentCount, (SELECT COUNT(1) FROM attachments a WHERE a.post_id = p.id) as attachmentCount, (SELECT COUNT(1) FROM comment_attachments ca WHERE ca.post_id = p.id) as commentAttachmentCount, (SELECT COUNT(1) FROM post_images i WHERE i.post_id = p.id) as imageCount FROM posts p LEFT JOIN users au ON au.id = p.author_id LEFT JOIN users bu ON bu.id = p.banned_by WHERE p.is_banned = 1 AND p.deleted_at IS NULL ORDER BY p.banned_at DESC, p.id DESC LIMIT ? OFFSET ?",
		[postsPageSize, postsOffset],
	);

	const shieldedCommentCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM comments WHERE is_shielded = 1 AND deleted_at IS NULL",
	);
	const shieldedCommentTotalCount = Number(shieldedCommentCountRow?.count ?? 0);
	const shieldedCommentTotalPages = Math.max(1, Math.ceil(shieldedCommentTotalCount / commentsPageSize));
	const commentsPage = Math.min(requestedCommentsPage, shieldedCommentTotalPages);
	const commentsOffset = (commentsPage - 1) * commentsPageSize;

	let shieldedComments: ShieldedCommentRow[] = [];
	try {
		shieldedComments = await queryAll<ShieldedCommentRow>(
			db,
			"SELECT c.id as id, c.post_id as postId, p.title as postTitle, c.author_id as authorId, au.display_name as authorName, c.content as content, c.created_at as createdAt, c.shielded_at as shieldedAt, c.shielded_by as shieldedBy, su.display_name as shieldedByName, c.shield_reason as shieldReason FROM comments c JOIN posts p ON p.id = c.post_id JOIN users au ON au.id = c.author_id LEFT JOIN users su ON su.id = c.shielded_by WHERE c.is_shielded = 1 AND c.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY c.shielded_at DESC, c.id DESC LIMIT ? OFFSET ?",
			[commentsPageSize, commentsOffset],
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such column") || message.includes("no such table")) {
			shieldedComments = [];
		} else {
			throw error;
		}
	}

	return json<LoaderData>({
		me,
		bannedPosts: {
			items: bannedPosts,
			page: postsPage,
			pageSize: postsPageSize,
			totalCount: bannedPostTotalCount,
			totalPages: bannedPostTotalPages,
		},
		shieldedComments: {
			items: shieldedComments,
			page: commentsPage,
			pageSize: commentsPageSize,
			totalCount: shieldedCommentTotalCount,
			totalPages: shieldedCommentTotalPages,
		},
	});
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (!isSuperadmin(me)) {
		return json<ActionData>({ ok: false, error: "只有超级管理员或站点管理员可执行该操作" }, { status: 403 });
	}

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "").trim();
	if (intent !== "hardDeleteBannedPosts" && intent !== "hardDeleteShieldedComments" && intent !== "bulkBanUsersFromShieldedComments") {
		return json<ActionData>({ ok: false, error: "未知操作" }, { status: 400 });
	}
	const ids = getSelectedIds(formData, intent === "hardDeleteBannedPosts" ? "postId" : "commentId");
	if (ids.length === 0) {
		return json<ActionData>({ ok: false, error: "未选择任何条目" }, { status: 400 });
	}
	if (ids.length > 200) {
		return json<ActionData>({ ok: false, error: "一次最多选择 200 条" }, { status: 400 });
	}

	const confirm = String(formData.get("confirm") || "").trim();
	if (confirm !== "1") {
		return json<ActionData>({ ok: false, error: "需要二次确认" }, { status: 400 });
	}
	const password = String(formData.get("password") || "");
	if (!password) {
		return json<ActionData>({ ok: false, error: "需要二次验证密码" }, { status: 400 });
	}
	const verified = await verifyLogin(context, me.email, password);
	if (!verified || verified.id !== me.id) {
		return json<ActionData>({ ok: false, error: "二次验证失败" }, { status: 403 });
	}

	const db = getDBFromContext(context);
	const ip = getClientIp(request);
	const userAgent = request.headers.get("User-Agent");
	const startedAt = Date.now();

	if (intent === "hardDeleteBannedPosts") {
		const placeholders = ids.map(() => "?").join(",");
		const rows = await queryAll<{ id: number }>(
			db,
			`SELECT id as id FROM posts WHERE deleted_at IS NULL AND is_banned = 1 AND id IN (${placeholders})`,
			ids,
		);
		const deletableIds = rows.map((r) => r.id);
		if (deletableIds.length === 0) {
			return json<ActionData>({ ok: false, error: "无可删除的封禁帖子" }, { status: 400 });
		}
		try {
			for (const postId of deletableIds) {
				await removeAllAttachmentsForPost(context, postId);
				await removeAllCommentAttachmentsForPost(context, postId);
				await removeAllPostImagesForPost(context, postId);
			}

			const delPlaceholders = deletableIds.map(() => "?").join(",");
			await execute(db, `DELETE FROM post_likes WHERE post_id IN (${delPlaceholders})`, deletableIds);
			await execute(db, `DELETE FROM comments WHERE post_id IN (${delPlaceholders})`, deletableIds);
			try {
				await execute(db, `DELETE FROM post_edits WHERE post_id IN (${delPlaceholders})`, deletableIds);
			} catch {
			}
			try {
				await execute(db, `DELETE FROM hidden_post_invites WHERE post_id IN (${delPlaceholders})`, deletableIds);
				await execute(db, `DELETE FROM hidden_post_access_tokens WHERE post_id IN (${delPlaceholders})`, deletableIds);
			} catch {
			}
			await execute(db, `DELETE FROM posts WHERE id IN (${delPlaceholders})`, deletableIds);

			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						me.id,
						"posts_banned_bulk_deleted",
						ip,
						userAgent,
						JSON.stringify({ count: deletableIds.length, postIds: deletableIds, requestedPostIds: ids }),
						startedAt,
					],
				);
			} catch {
			}

			return json<ActionData>({ ok: true, intent, deletedCount: deletableIds.length, deletedIds: deletableIds });
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						me.id,
						"posts_banned_bulk_delete_failed",
						ip,
						userAgent,
						JSON.stringify({ requestedPostIds: ids, message }),
						Date.now(),
					],
				);
			} catch {
			}
			return json<ActionData>({ ok: false, error: "删除失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "hardDeleteShieldedComments") {
		const placeholders = ids.map(() => "?").join(",");
		const rows = await queryAll<{ id: number }>(
			db,
			`SELECT id as id FROM comments WHERE deleted_at IS NULL AND is_shielded = 1 AND id IN (${placeholders})`,
			ids,
		);
		const deletableIds = rows.map((r) => r.id);
		if (deletableIds.length === 0) {
			return json<ActionData>({ ok: false, error: "无可删除的屏蔽评论" }, { status: 400 });
		}
		try {
			await removeAllCommentAttachmentUploadsForComments(context, deletableIds);
			await removeAllCommentAttachmentsForComments(context, deletableIds);
			const delPlaceholders = deletableIds.map(() => "?").join(",");
			await execute(db, `DELETE FROM comments WHERE id IN (${delPlaceholders})`, deletableIds);
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						me.id,
						"comments_shielded_bulk_deleted",
						ip,
						userAgent,
						JSON.stringify({ count: deletableIds.length, commentIds: deletableIds, requestedCommentIds: ids }),
						startedAt,
					],
				);
			} catch {
			}
			return json<ActionData>({ ok: true, intent, deletedCount: deletableIds.length, deletedIds: deletableIds });
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			try {
				await execute(
					db,
					"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[
						me.id,
						"comments_shielded_bulk_delete_failed",
						ip,
						userAgent,
						JSON.stringify({ requestedCommentIds: ids, message }),
						Date.now(),
					],
				);
			} catch {
			}
			return json<ActionData>({ ok: false, error: "删除失败，请稍后重试" }, { status: 500 });
		}
	}

	const placeholders = ids.map(() => "?").join(",");
	const authorRows = await queryAll<{ authorId: number }>(
		db,
		`SELECT DISTINCT author_id as authorId FROM comments WHERE deleted_at IS NULL AND is_shielded = 1 AND id IN (${placeholders})`,
		ids,
	);
	const authorIds = Array.from(new Set(authorRows.map((r) => r.authorId))).filter((n) => Number.isFinite(n) && n > 0);
	if (authorIds.length === 0) {
		return json<ActionData>({ ok: false, error: "未找到可封禁的用户" }, { status: 400 });
	}
	const authorPlaceholders = authorIds.map(() => "?").join(",");
	const users = await queryAll<{ id: number; role: string; isBanned: number }>(
		db,
		`SELECT id as id, role as role, is_banned as isBanned FROM users WHERE id IN (${authorPlaceholders})`,
		authorIds,
	);
	const now = Date.now();
	const skipped: { userId: number; reason: string }[] = [];
	const alreadyBannedUserIds: number[] = [];
	const bannableIds: number[] = [];
	for (const u of users) {
		if (u.id === me.id) {
			skipped.push({ userId: u.id, reason: "不能封禁自己" });
			continue;
		}
		if (String(u.role) === "topadmin" && me.role !== "topadmin") {
			skipped.push({ userId: u.id, reason: "无权封禁 topadmin" });
			continue;
		}
		if (String(u.role) === "superadmin" && me.role !== "superadmin" && me.role !== "topadmin") {
			skipped.push({ userId: u.id, reason: "无权封禁超级管理员" });
			continue;
		}
		if (u.isBanned) {
			alreadyBannedUserIds.push(u.id);
			continue;
		}
		bannableIds.push(u.id);
	}
	if (bannableIds.length === 0) {
		return json<ActionData>({
			ok: true,
			intent,
			bannedCount: 0,
			bannedUserIds: [],
			alreadyBannedUserIds,
			skipped,
		});
	}
	try {
		const banPlaceholders = bannableIds.map(() => "?").join(",");
		await execute(db, `UPDATE users SET is_banned = 1, banned_at = ? WHERE id IN (${banPlaceholders})`, [now, ...bannableIds]);
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					me.id,
					"users_banned_bulk_from_shielded_comments",
					ip,
					userAgent,
					JSON.stringify({ bannedUserIds: bannableIds, requestedCommentIds: ids, skipped, alreadyBannedUserIds }),
					now,
				],
			);
		} catch {
		}
		return json<ActionData>({
			ok: true,
			intent,
			bannedCount: bannableIds.length,
			bannedUserIds: bannableIds,
			alreadyBannedUserIds,
			skipped,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					me.id,
					"users_banned_bulk_from_shielded_comments_failed",
					ip,
					userAgent,
					JSON.stringify({ requestedCommentIds: ids, message }),
					Date.now(),
				],
			);
		} catch {
		}
		return json<ActionData>({ ok: false, error: "封禁失败，请稍后重试" }, { status: 500 });
	}
}

export default function AdminBulkDeleteBannedContentPage() {
	const data = useLoaderData<typeof loader>();
	const revalidator = useRevalidator();
	const postsDeleteFetcher = useFetcher<ActionData>();
	const commentsDeleteFetcher = useFetcher<ActionData>();
	const banUsersFetcher = useFetcher<ActionData>();
	const handledRef = useRef<Record<string, boolean>>({});
	const [selectedPostIds, setSelectedPostIds] = useState<Set<number>>(() => new Set());
	const [selectedCommentIds, setSelectedCommentIds] = useState<Set<number>>(() => new Set());
	const [confirmChecked, setConfirmChecked] = useState(false);
	const [password, setPassword] = useState("");
	const [highlightCommentId, setHighlightCommentId] = useState<number | null>(null);
	const [highlightExpiresAt, setHighlightExpiresAt] = useState<number>(0);

	useEffect(() => {
		setSelectedPostIds(new Set());
		setSelectedCommentIds(new Set());
		setConfirmChecked(false);
		setPassword("");
	}, [data.bannedPosts.page, data.shieldedComments.page]);

	useEffect(() => {
		const readHighlight = () => {
			try {
				const raw = localStorage.getItem("moderationLastShieldedComment");
				if (!raw) return;
				const parsed = JSON.parse(raw) as any;
				const commentId = Number(parsed?.commentId);
				const ts = Number(parsed?.ts);
				if (!Number.isFinite(commentId) || commentId <= 0) return;
				if (!Number.isFinite(ts) || ts <= 0) return;
				setHighlightCommentId(Math.floor(commentId));
				setHighlightExpiresAt(ts + 60_000);
			} catch {
				return;
			}
		};
		readHighlight();
		function onStorage(e: StorageEvent) {
			if (e.key !== "moderationLastShieldedComment") return;
			readHighlight();
			revalidator.revalidate();
		}
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [revalidator]);

	useEffect(() => {
		let active = true;
		const tick = () => {
			if (!active) return;
			if (revalidator.state !== "idle") return;
			revalidator.revalidate();
		};
		const id = setInterval(tick, 5000);
		const onVisibility = () => {
			if (document.visibilityState === "visible") {
				tick();
			}
		};
		window.addEventListener("focus", tick);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			active = false;
			clearInterval(id);
			window.removeEventListener("focus", tick);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [revalidator]);

	useEffect(() => {
		const fetchers = [postsDeleteFetcher, commentsDeleteFetcher, banUsersFetcher];
		for (const f of fetchers) {
			if (f.state === "submitting") {
				handledRef.current = {};
				return;
			}
		}
		for (const f of fetchers) {
			if (f.state !== "idle") return;
			if (!f.data) continue;
			if (!f.data.ok) continue;
			const key = `${f.data.intent}:${"deletedCount" in f.data ? f.data.deletedCount : f.data.bannedCount}`;
			if (handledRef.current[key]) continue;
			handledRef.current[key] = true;
			setSelectedPostIds(new Set());
			setSelectedCommentIds(new Set());
			revalidator.revalidate();
		}
	}, [postsDeleteFetcher.state, postsDeleteFetcher.data, commentsDeleteFetcher.state, commentsDeleteFetcher.data, banUsersFetcher.state, banUsersFetcher.data, revalidator]);

	const bannedPostsAllOnPageSelected =
		data.bannedPosts.items.length > 0 && data.bannedPosts.items.every((p) => selectedPostIds.has(p.id));
	const bannedPostsSelectedCount = selectedPostIds.size;
	const canSubmitBannedPostsDelete =
		bannedPostsSelectedCount > 0 &&
		bannedPostsSelectedCount <= 200 &&
		confirmChecked &&
		Boolean(password) &&
		postsDeleteFetcher.state !== "submitting";

	const shieldedCommentsAllOnPageSelected =
		data.shieldedComments.items.length > 0 && data.shieldedComments.items.every((c) => selectedCommentIds.has(c.id));
	const shieldedCommentsSelectedCount = selectedCommentIds.size;
	const canSubmitShieldedCommentsDelete =
		shieldedCommentsSelectedCount > 0 &&
		shieldedCommentsSelectedCount <= 200 &&
		confirmChecked &&
		Boolean(password) &&
		commentsDeleteFetcher.state !== "submitting";
	const canSubmitBanUsers =
		shieldedCommentsSelectedCount > 0 &&
		shieldedCommentsSelectedCount <= 200 &&
		confirmChecked &&
		Boolean(password) &&
		banUsersFetcher.state !== "submitting";

	const error =
		(postsDeleteFetcher.data && !postsDeleteFetcher.data.ok ? postsDeleteFetcher.data.error : null) ||
		(commentsDeleteFetcher.data && !commentsDeleteFetcher.data.ok ? commentsDeleteFetcher.data.error : null) ||
		(banUsersFetcher.data && !banUsersFetcher.data.ok ? banUsersFetcher.data.error : null);

	function toggleSelectPost(id: number) {
		setSelectedPostIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function toggleSelectAllBannedPostsOnPage() {
		setSelectedPostIds((prev) => {
			const next = new Set(prev);
			if (bannedPostsAllOnPageSelected) {
				for (const p of data.bannedPosts.items) next.delete(p.id);
			} else {
				for (const p of data.bannedPosts.items) next.add(p.id);
			}
			return next;
		});
	}

	function toggleSelectComment(id: number) {
		setSelectedCommentIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function toggleSelectAllShieldedCommentsOnPage() {
		setSelectedCommentIds((prev) => {
			const next = new Set(prev);
			if (shieldedCommentsAllOnPageSelected) {
				for (const c of data.shieldedComments.items) next.delete(c.id);
			} else {
				for (const c of data.shieldedComments.items) next.add(c.id);
			}
			return next;
		});
	}

	function submitBulkDeleteBannedPosts() {
		const ids = Array.from(selectedPostIds);
		if (ids.length === 0) return;
		if (ids.length > 200) return;
		if (!confirmChecked) return;
		if (!password) return;
		const ok = window.confirm(`确认永久删除所选 ${ids.length} 条封禁帖子吗？此操作不可恢复。`);
		if (!ok) return;
		const form = new FormData();
		form.append("intent", "hardDeleteBannedPosts");
		form.append("confirm", "1");
		form.append("password", password);
		for (const id of ids) form.append("postId", String(id));
		postsDeleteFetcher.submit(form, { method: "post" });
	}

	function submitBulkDeleteShieldedComments() {
		const ids = Array.from(selectedCommentIds);
		if (ids.length === 0) return;
		if (ids.length > 200) return;
		if (!confirmChecked) return;
		if (!password) return;
		const ok = window.confirm(`确认永久删除所选 ${ids.length} 条屏蔽评论吗？此操作不可恢复。`);
		if (!ok) return;
		const form = new FormData();
		form.append("intent", "hardDeleteShieldedComments");
		form.append("confirm", "1");
		form.append("password", password);
		for (const id of ids) form.append("commentId", String(id));
		commentsDeleteFetcher.submit(form, { method: "post" });
	}

	function submitBulkBanUsersFromComments() {
		const ids = Array.from(selectedCommentIds);
		if (ids.length === 0) return;
		if (ids.length > 200) return;
		if (!confirmChecked) return;
		if (!password) return;
		const ok = window.confirm(`确认根据所选 ${ids.length} 条屏蔽评论批量封禁相关用户吗？`);
		if (!ok) return;
		const form = new FormData();
		form.append("intent", "bulkBanUsersFromShieldedComments");
		form.append("confirm", "1");
		form.append("password", password);
		for (const id of ids) form.append("commentId", String(id));
		banUsersFetcher.submit(form, { method: "post" });
	}

	const query = useMemo(() => {
		const sp = new URLSearchParams();
		if (data.bannedPosts.page > 1) sp.set("postsPage", String(data.bannedPosts.page));
		if (data.shieldedComments.page > 1) sp.set("commentsPage", String(data.shieldedComments.page));
		return sp;
	}, [data.bannedPosts.page, data.shieldedComments.page]);

	const postsCanPrev = data.bannedPosts.page > 1;
	const postsCanNext = data.bannedPosts.page < data.bannedPosts.totalPages;
	const commentsCanPrev = data.shieldedComments.page > 1;
	const commentsCanNext = data.shieldedComments.page < data.shieldedComments.totalPages;

	const highlightActive = Boolean(highlightCommentId && Date.now() < highlightExpiresAt);

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-5xl flex-col gap-6">
				<header className="flex items-center justify-between gap-3">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">批量删除封禁</h1>
					<div className="flex flex-wrap items-center gap-2">
						<Link
							to="/admin/users"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							用户管理
						</Link>
						<Link
							to="/posts"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							返回论坛
						</Link>
					</div>
				</header>

				{error ? (
					<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						{error}
					</div>
				) : null}

				<div className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
						<div className="text-sm text-gray-700 dark:text-gray-200">
							<div>
								封禁帖子：{data.bannedPosts.totalCount} 条；屏蔽评论：{data.shieldedComments.totalCount} 条
							</div>
							<div>
								已选帖子：{bannedPostsSelectedCount} 条；已选评论：{shieldedCommentsSelectedCount} 条（单次最多 200 条）
							</div>
						</div>
						<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
							<label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
								<input
									type="checkbox"
									checked={confirmChecked}
									onChange={(e) => setConfirmChecked(e.target.checked)}
								/>
								<span>我已了解此操作不可恢复</span>
							</label>
							<label className="flex flex-col gap-1 text-sm text-gray-700 dark:text-gray-200">
								<span>二次验证密码</span>
								<input
									type="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									className="w-56 rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
									placeholder="请输入当前账号密码"
								/>
							</label>
							<div className="text-xs text-gray-500 dark:text-gray-400">
								批量操作按钮在各自列表区域内
							</div>
						</div>
					</div>
				</div>

				<section className="rounded-xl bg-white shadow dark:bg-gray-800">
					<div className="flex flex-col gap-2 border-b border-gray-200 p-4 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between">
						<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">待处理封禁帖子</h2>
						<button
							type="button"
							onClick={submitBulkDeleteBannedPosts}
							disabled={!canSubmitBannedPostsDelete}
							className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
						>
							{postsDeleteFetcher.state === "submitting" ? "删除中..." : "批量永久删除"}
						</button>
					</div>
					<div className="overflow-hidden">
						<table className="w-full table-auto text-left text-sm">
							<thead className="bg-gray-100 text-xs text-gray-600 dark:bg-gray-900/30 dark:text-gray-300">
								<tr>
									<th className="px-4 py-3">
										<label className="flex items-center gap-2">
											<input
												type="checkbox"
												checked={bannedPostsAllOnPageSelected}
												onChange={toggleSelectAllBannedPostsOnPage}
											/>
											<span>全选本页</span>
										</label>
									</th>
									<th className="px-4 py-3">ID</th>
									<th className="px-4 py-3">标题</th>
									<th className="px-4 py-3">作者</th>
									<th className="px-4 py-3">封禁信息</th>
									<th className="px-4 py-3">关联数据</th>
									<th className="px-4 py-3">创建时间</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-200 dark:divide-gray-700">
								{data.bannedPosts.items.map((p) => (
									<tr key={p.id} className="text-gray-900 dark:text-gray-100">
										<td className="px-4 py-3">
											<input
												type="checkbox"
												checked={selectedPostIds.has(p.id)}
												onChange={() => toggleSelectPost(p.id)}
											/>
										</td>
										<td className="px-4 py-3">{p.id}</td>
										<td className="px-4 py-3">
											<Link to={`/posts/${p.id}`} className="text-blue-600 hover:underline dark:text-blue-400">
												{p.title}
											</Link>
										</td>
										<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
											{p.authorName || "-"}（{p.authorId}）
										</td>
										<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
											<div>{p.bannedAt ? new Date(p.bannedAt).toLocaleString() : "-"}</div>
											<div className="text-xs text-gray-500 dark:text-gray-400">
												操作者：{p.bannedByName || "-"}
												{p.bannedBy ? `（${p.bannedBy}）` : ""}
											</div>
											{p.bannedReason ? (
												<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">原因：{p.bannedReason}</div>
											) : null}
										</td>
										<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
											<div>评论：{p.commentCount}</div>
											<div className="text-xs text-gray-500 dark:text-gray-400">
												附件：{p.attachmentCount}；评论附件：{p.commentAttachmentCount}；图片：{p.imageCount}
											</div>
										</td>
										<td className="px-4 py-3 text-gray-700 dark:text-gray-200">{new Date(p.createdAt).toLocaleString()}</td>
									</tr>
								))}
								{data.bannedPosts.items.length === 0 ? (
									<tr>
										<td className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400" colSpan={7}>
											暂无封禁帖子
										</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</div>
					<div className="flex items-center justify-between p-4">
						<div className="text-sm text-gray-600 dark:text-gray-300">
							第 {data.bannedPosts.page} / {data.bannedPosts.totalPages} 页
						</div>
						<div className="flex items-center gap-2">
							<Link
								to={(() => {
									const sp = new URLSearchParams(query);
									sp.set("postsPage", String(Math.max(1, data.bannedPosts.page - 1)));
									return `/admin/posts/bulk-delete?${sp.toString()}`;
								})()}
								aria-disabled={!postsCanPrev}
								className={
									postsCanPrev
										? "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										: "cursor-not-allowed rounded border border-gray-200 px-3 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-600"
								}
								onClick={(e) => {
									if (!postsCanPrev) e.preventDefault();
								}}
							>
								上一页
							</Link>
							<Link
								to={(() => {
									const sp = new URLSearchParams(query);
									sp.set("postsPage", String(data.bannedPosts.page + 1));
									return `/admin/posts/bulk-delete?${sp.toString()}`;
								})()}
								aria-disabled={!postsCanNext}
								className={
									postsCanNext
										? "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										: "cursor-not-allowed rounded border border-gray-200 px-3 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-600"
								}
								onClick={(e) => {
									if (!postsCanNext) e.preventDefault();
								}}
							>
								下一页
							</Link>
						</div>
					</div>
				</section>

				<section className="rounded-xl bg-white shadow dark:bg-gray-800">
					<div className="flex flex-col gap-2 border-b border-gray-200 p-4 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between">
						<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">待处理屏蔽评论</h2>
						<div className="flex flex-wrap items-center gap-2">
							<button
								type="button"
								onClick={submitBulkDeleteShieldedComments}
								disabled={!canSubmitShieldedCommentsDelete}
								className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
							>
								{commentsDeleteFetcher.state === "submitting" ? "删除中..." : "批量删除"}
							</button>
							<button
								type="button"
								onClick={submitBulkBanUsersFromComments}
								disabled={!canSubmitBanUsers}
								className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
							>
								{banUsersFetcher.state === "submitting" ? "封禁中..." : "批量封禁用户"}
							</button>
						</div>
					</div>
					<div className="overflow-hidden">
						<table className="w-full table-auto text-left text-sm">
							<thead className="bg-gray-100 text-xs text-gray-600 dark:bg-gray-900/30 dark:text-gray-300">
								<tr>
									<th className="px-4 py-3">
										<label className="flex items-center gap-2">
											<input
												type="checkbox"
												checked={shieldedCommentsAllOnPageSelected}
												onChange={toggleSelectAllShieldedCommentsOnPage}
											/>
											<span>全选本页</span>
										</label>
									</th>
									<th className="px-4 py-3">评论ID</th>
									<th className="px-4 py-3">帖子</th>
									<th className="px-4 py-3">作者</th>
									<th className="px-4 py-3">屏蔽信息</th>
									<th className="px-4 py-3">内容</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-200 dark:divide-gray-700">
								{data.shieldedComments.items.map((c) => {
									const shouldHighlight = highlightActive && highlightCommentId === c.id;
									return (
										<tr
											key={c.id}
											className={
												shouldHighlight
													? "bg-red-50 text-gray-900 dark:bg-red-900/10 dark:text-gray-100"
													: "text-gray-900 dark:text-gray-100"
											}
										>
											<td className="px-4 py-3">
												<input
													type="checkbox"
													checked={selectedCommentIds.has(c.id)}
													onChange={() => toggleSelectComment(c.id)}
												/>
											</td>
											<td className="px-4 py-3">{c.id}</td>
											<td className="px-4 py-3">
												<Link to={`/posts/${c.postId}`} className="text-blue-600 hover:underline dark:text-blue-400">
													{c.postTitle || `帖子 ${c.postId}`}
												</Link>
												<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">帖子ID：{c.postId}</div>
											</td>
											<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
												{c.authorName || "-"}（{c.authorId}）
											</td>
											<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
												<div>{c.shieldedAt ? new Date(c.shieldedAt).toLocaleString() : "-"}</div>
												<div className="text-xs text-gray-500 dark:text-gray-400">
													操作者：{c.shieldedByName || "-"}
													{c.shieldedBy ? `（${c.shieldedBy}）` : ""}
												</div>
												{c.shieldReason ? <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">原因：{c.shieldReason}</div> : null}
											</td>
											<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
												<div className="line-clamp-3 whitespace-pre-wrap break-words">{c.content}</div>
												<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">发表于：{new Date(c.createdAt).toLocaleString()}</div>
											</td>
										</tr>
									);
								})}
								{data.shieldedComments.items.length === 0 ? (
									<tr>
										<td className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400" colSpan={6}>
											暂无屏蔽评论
										</td>
									</tr>
								) : null}
							</tbody>
						</table>
					</div>
					<div className="flex items-center justify-between p-4">
						<div className="text-sm text-gray-600 dark:text-gray-300">
							第 {data.shieldedComments.page} / {data.shieldedComments.totalPages} 页
						</div>
						<div className="flex items-center gap-2">
							<Link
								to={(() => {
									const sp = new URLSearchParams(query);
									sp.set("commentsPage", String(Math.max(1, data.shieldedComments.page - 1)));
									return `/admin/posts/bulk-delete?${sp.toString()}`;
								})()}
								aria-disabled={!commentsCanPrev}
								className={
									commentsCanPrev
										? "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										: "cursor-not-allowed rounded border border-gray-200 px-3 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-600"
								}
								onClick={(e) => {
									if (!commentsCanPrev) e.preventDefault();
								}}
							>
								上一页
							</Link>
							<Link
								to={(() => {
									const sp = new URLSearchParams(query);
									sp.set("commentsPage", String(data.shieldedComments.page + 1));
									return `/admin/posts/bulk-delete?${sp.toString()}`;
								})()}
								aria-disabled={!commentsCanNext}
								className={
									commentsCanNext
										? "rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										: "cursor-not-allowed rounded border border-gray-200 px-3 py-1 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-600"
								}
								onClick={(e) => {
									if (!commentsCanNext) e.preventDefault();
								}}
							>
								下一页
							</Link>
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}
