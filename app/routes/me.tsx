import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import {
	Link,
	Outlet,
	useFetcher,
	useLoaderData,
	useLocation,
	useNavigate,
	useSearchParams,
} from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { getDailyQuotaStatus, requireUser } from "~/lib/auth.server";
import { getDBFromContext, queryOne } from "~/lib/d1.server";

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	quota: Awaited<ReturnType<typeof getDailyQuotaStatus>>;
	stats: {
		postCount: number;
		commentCount: number;
		likeCount: number;
	};
};

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	const db = getDBFromContext(context);
	const quota = await getDailyQuotaStatus({ context, user: me });

	const postCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM posts WHERE author_id = ? AND deleted_at IS NULL",
		[me.id],
	);
	const commentCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM comments WHERE author_id = ? AND deleted_at IS NULL",
		[me.id],
	);
	const likeCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM post_likes WHERE user_id = ?",
		[me.id],
	);

	return json<LoaderData>({
		me,
		quota,
		stats: {
			postCount: Number(postCountRow?.count ?? 0),
			commentCount: Number(commentCountRow?.count ?? 0),
			likeCount: Number(likeCountRow?.count ?? 0),
		},
	});
}

export default function MePage() {
	const data = useLoaderData<typeof loader>();
	const me = data.me;
	const isBanned = Boolean(me.isBanned);
	const quotaFetcher = useFetcher<LoaderData>();
	const [quotaState, setQuotaState] = useState(() => ({ quota: data.quota, updatedAt: Date.now() }));
	const quota = quotaState.quota;
	const quotaUnavailable = me.role === "user" && quota.post.limit === null && quota.comment.limit === null;
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const [navError, setNavError] = useState<string | null>(null);
	const forcedOnceRef = useRef(false);
	const pwdChanged = searchParams.get("pwdChanged") === "1";
	const [now, setNow] = useState(() => Date.now());
	const quotaCacheKey = "me:daily-quota";

	const resetDiff = Math.max(0, quota.nextResetAt - now);
	const resetSeconds = Math.floor(resetDiff / 1000);
	const resetHours = Math.floor(resetSeconds / 3600);
	const resetMinutes = Math.floor((resetSeconds % 3600) / 60);
	const resetRestSeconds = resetSeconds % 60;

	function formatQuotaPart(args: { used: number; limit: number | null; remaining: number | null }) {
		if (args.limit === null) {
			if (me.role === "admin" || me.role === "superadmin") {
				return `已用 ${args.used}（不限额）`;
			}
			return "暂不可用";
		}
		const remaining = args.remaining ?? Math.max(0, args.limit - args.used);
		return `${remaining}/${args.limit}`;
	}

	function getPercent(args: { used: number; limit: number | null }) {
		if (args.limit === null) {
			return 0;
		}
		if (args.limit <= 0) {
			return 100;
		}
		const pct = Math.round((args.used / args.limit) * 100);
		return Math.max(0, Math.min(100, pct));
	}

	function isLow(args: { limit: number | null; remaining: number | null }) {
		if (args.limit === null) return false;
		const remaining = args.remaining ?? 0;
		return args.limit > 0 && remaining <= Math.min(2, Math.ceil(args.limit * 0.2));
	}

	const canCreatePost =
		!isBanned &&
		!quotaUnavailable &&
		(quota.post.limit === null || (quota.post.remaining ?? 0) > 0);

	useEffect(() => {
		if (forcedOnceRef.current) {
			return;
		}
		if (!me.mustChangePassword) {
			return;
		}
		forcedOnceRef.current = true;
		let reason = "系统检测到你正在使用临时密码登录，请立即修改密码";
		if (me.tempPasswordExpiresAt) {
			const diff = me.tempPasswordExpiresAt - Date.now();
			if (diff > 0) {
				const seconds = Math.floor(diff / 1000);
				const minutes = Math.floor(seconds / 60);
				const rest = seconds % 60;
				reason = `系统检测到你正在使用临时密码登录，请立即修改密码（剩余 ${minutes}分${rest
					.toString()
					.padStart(2, "0")}秒）`;
			}
		}
		openPwdModal(reason);
	}, [me.mustChangePassword, me.tempPasswordExpiresAt]);

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		setQuotaState({ quota: data.quota, updatedAt: Date.now() });
	}, [data.quota]);

	useEffect(() => {
		try {
			const raw = localStorage.getItem(quotaCacheKey);
			if (!raw) return;
			const parsed = JSON.parse(raw) as any;
			if (!parsed || typeof parsed !== "object") return;
			if (typeof parsed.updatedAt !== "number") return;
			if (!parsed.quota || typeof parsed.quota !== "object") return;
			if (parsed.updatedAt > quotaState.updatedAt) {
				setQuotaState({ quota: parsed.quota, updatedAt: parsed.updatedAt });
			}
		} catch {
			return;
		}
	}, []);

	useEffect(() => {
		try {
			localStorage.setItem(quotaCacheKey, JSON.stringify(quotaState));
		} catch {
			return;
		}
	}, [quotaState]);

	useEffect(() => {
		function refresh() {
			if (quotaFetcher.state !== "idle") return;
			quotaFetcher.load("/me");
		}
		const id = setInterval(refresh, 30000);
		window.addEventListener("focus", refresh);
		function onVis() {
			if (document.visibilityState === "visible") {
				refresh();
			}
		}
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [quotaFetcher]);

	useEffect(() => {
		if (!quotaFetcher.data?.quota) return;
		setQuotaState({ quota: quotaFetcher.data.quota, updatedAt: Date.now() });
	}, [quotaFetcher.data]);

	useEffect(() => {
		function onStorage(e: StorageEvent) {
			if (e.key !== quotaCacheKey) return;
			if (!e.newValue) return;
			try {
				const parsed = JSON.parse(e.newValue) as any;
				if (!parsed || typeof parsed.updatedAt !== "number") return;
				if (!parsed.quota || typeof parsed.quota !== "object") return;
				if (parsed.updatedAt <= quotaState.updatedAt) return;
				setQuotaState({ quota: parsed.quota, updatedAt: parsed.updatedAt });
			} catch {
				return;
			}
		}
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [quotaState.updatedAt]);

	function openPwdModal(reason?: string) {
		setNavError(reason ?? null);
		const target = reason ? "/me/password?force=1" : "/me/password";
		const [path, rawSearch] = target.split("?");
		const search = rawSearch ? `?${rawSearch}` : "";
		if (location.pathname === path && location.search === search) {
			return;
		}
		navigate(target, { replace: true });
	}

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex items-start justify-between gap-4">
					<div>
						<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
							个人中心
						</h1>
						<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
							{me.displayName}（{me.role}）
						</p>
						{isBanned ? (
							<p className="mt-2 text-sm text-red-600 dark:text-red-200">账号已被封禁</p>
						) : null}
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Link
							to="/messages"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							消息中心
						</Link>
						<Link
							to="/posts"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							返回论坛
						</Link>
					</div>
				</header>

				<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
					<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2">
								<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
									今日发帖/评论限额
								</h2>
								{quota.overrideId ? (
									<span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
										临时限额
									</span>
								) : null}
							</div>
							<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
								重置倒计时：{resetHours.toString().padStart(2, "0")}:
								{resetMinutes.toString().padStart(2, "0")}:
								{resetRestSeconds.toString().padStart(2, "0")}
							</p>
							{quotaUnavailable ? (
								<p className="mt-2 text-sm text-red-600 dark:text-red-200">
									限额信息暂不可用，请稍后刷新或联系管理员
								</p>
							) : null}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Link
								to={canCreatePost ? "/posts/new" : "#"}
								onClick={(e) => {
									if (canCreatePost) return;
									e.preventDefault();
								}}
								className={
									canCreatePost
										? "rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
										: "cursor-not-allowed rounded bg-gray-300 px-4 py-2 text-sm font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300"
								}
								aria-disabled={!canCreatePost}
							>
								发新帖
							</Link>
							<Link
								to="/messages"
								className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
							>
								申请增加额度
							</Link>
						</div>
					</div>

					<div className="mt-5 space-y-4">
						<div>
							<div className="flex items-center justify-between gap-3">
								<p className="text-sm font-medium text-gray-900 dark:text-gray-100">发帖</p>
								<p
									className={
										quota.post.limit !== null && (quota.post.remaining ?? 0) <= 0
											? "text-sm font-medium text-red-600 dark:text-red-200"
											: isLow({ limit: quota.post.limit, remaining: quota.post.remaining })
												? "text-sm font-medium text-amber-600 dark:text-amber-200"
												: "text-sm text-gray-700 dark:text-gray-200"
									}
								>
									{formatQuotaPart({
										used: quota.post.used,
										limit: quota.post.limit,
										remaining: quota.post.remaining,
									})}
								</p>
							</div>
							<div className="mt-2 h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
								<div
									className={
										quota.post.limit !== null && (quota.post.remaining ?? 0) <= 0
											? "h-full bg-red-500"
											: isLow({ limit: quota.post.limit, remaining: quota.post.remaining })
												? "h-full bg-amber-500"
												: "h-full bg-blue-500"
									}
									style={{ width: `${getPercent({ used: quota.post.used, limit: quota.post.limit })}%` }}
								/>
							</div>
							{quota.post.limit !== null && (quota.post.remaining ?? 0) <= 0 ? (
								<p className="mt-2 text-sm text-red-600 dark:text-red-200">
									今日发帖额度已用尽
								</p>
							) : isLow({ limit: quota.post.limit, remaining: quota.post.remaining }) ? (
								<p className="mt-2 text-sm text-amber-700 dark:text-amber-200">
									发帖额度接近用完
								</p>
							) : null}
						</div>

						<div>
							<div className="flex items-center justify-between gap-3">
								<p className="text-sm font-medium text-gray-900 dark:text-gray-100">评论</p>
								<p
									className={
										quota.comment.limit !== null && (quota.comment.remaining ?? 0) <= 0
											? "text-sm font-medium text-red-600 dark:text-red-200"
											: isLow({ limit: quota.comment.limit, remaining: quota.comment.remaining })
												? "text-sm font-medium text-amber-600 dark:text-amber-200"
												: "text-sm text-gray-700 dark:text-gray-200"
									}
								>
									{formatQuotaPart({
										used: quota.comment.used,
										limit: quota.comment.limit,
										remaining: quota.comment.remaining,
									})}
								</p>
							</div>
							<div className="mt-2 h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
								<div
									className={
										quota.comment.limit !== null && (quota.comment.remaining ?? 0) <= 0
											? "h-full bg-red-500"
											: isLow({ limit: quota.comment.limit, remaining: quota.comment.remaining })
												? "h-full bg-amber-500"
												: "h-full bg-blue-500"
									}
									style={{ width: `${getPercent({ used: quota.comment.used, limit: quota.comment.limit })}%` }}
								/>
							</div>
							{quota.comment.limit !== null && (quota.comment.remaining ?? 0) <= 0 ? (
								<p className="mt-2 text-sm text-red-600 dark:text-red-200">
									今日评论额度已用尽
								</p>
							) : isLow({ limit: quota.comment.limit, remaining: quota.comment.remaining }) ? (
								<p className="mt-2 text-sm text-amber-700 dark:text-amber-200">
									评论额度接近用完
								</p>
							) : null}
						</div>
					</div>

					<details className="mt-4 rounded-lg border border-gray-200 p-4 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-200">
						<summary className="cursor-pointer select-none font-medium text-gray-900 dark:text-gray-100">
							查看详细使用规则
						</summary>
						<div className="mt-3 space-y-2">
							<p>普通用户默认每日限额：发帖 10 条、评论 20 条。</p>
							<p>管理员/超级管理员不限额（仍会记录用量用于统计）。</p>
							<p>
								如需临时提高额度，可在 <Link to="/messages" className="underline">消息中心</Link> 给管理员发送申请。
							</p>
							{me.role === "admin" || me.role === "superadmin" ? (
								<p>
									可在 <Link to="/admin/quotas" className="underline">限额管理</Link> 为用户设置临时限额（有有效期）。
								</p>
							) : null}
						</div>
					</details>
				</section>

				<section className="overflow-hidden rounded-xl bg-white shadow dark:bg-gray-800">
					<div className="grid grid-cols-1 gap-0 divide-y divide-gray-200 dark:divide-gray-700 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
						<div className="p-5">
							<p className="text-xs text-gray-500 dark:text-gray-400">我的帖子</p>
							<p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
								{data.stats.postCount}
							</p>
						</div>
						<div className="p-5">
							<p className="text-xs text-gray-500 dark:text-gray-400">我的评论</p>
							<p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
								{data.stats.commentCount}
							</p>
						</div>
						<div className="p-5">
							<p className="text-xs text-gray-500 dark:text-gray-400">我的点赞</p>
							<p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
								{data.stats.likeCount}
							</p>
						</div>
					</div>
				</section>

				<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">账号信息</h2>
					{pwdChanged ? (
						<div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-200">
							密码已修改，请使用新密码登录
						</div>
					) : null}
					{navError ? (
						<div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
							{navError}
						</div>
					) : null}
					<div className="mt-4 flex flex-wrap items-center gap-2">
						<a
							href="/me/password"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							修改密码
						</a>
						<Link
							to="/me/posts"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							我的帖子管理
						</Link>
						<Link
							to="/me/comments"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							我的评论管理
						</Link>
					</div>
					<dl className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
						<div>
							<dt className="text-gray-500 dark:text-gray-400">邮箱</dt>
							<dd className="mt-1 break-all text-gray-900 dark:text-gray-100">{me.email}</dd>
						</div>
						<div>
							<dt className="text-gray-500 dark:text-gray-400">注册时间</dt>
							<dd className="mt-1 text-gray-900 dark:text-gray-100">
								{new Date(me.createdAt).toLocaleString()}
							</dd>
						</div>
						{me.bannedAt ? (
							<div>
								<dt className="text-gray-500 dark:text-gray-400">封禁时间</dt>
								<dd className="mt-1 text-gray-900 dark:text-gray-100">
									{new Date(me.bannedAt).toLocaleString()}
								</dd>
							</div>
						) : null}
					</dl>
				</section>
			</div>
			<Outlet />
		</div>
	);
}
