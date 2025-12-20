import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { requireUser } from "~/lib/auth.server";
import { getDBFromContext, queryOne } from "~/lib/d1.server";

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	stats: {
		postCount: number;
		commentCount: number;
		likeCount: number;
	};
};

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	const db = getDBFromContext(context);

	const postCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM posts WHERE author_id = ?",
		[me.id],
	);
	const commentCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM comments WHERE author_id = ?",
		[me.id],
	);
	const likeCountRow = await queryOne<{ count: number | string }>(
		db,
		"SELECT COUNT(1) as count FROM post_likes WHERE user_id = ?",
		[me.id],
	);

	return json<LoaderData>({
		me,
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
	const navigate = useNavigate();
	const [navError, setNavError] = useState<string | null>(null);
	const [searchParams, setSearchParams] = useSearchParams();

	const sendFetcher = useFetcher<any>();
	const verifyFetcher = useFetcher<any>();
	const [showPwdModal, setShowPwdModal] = useState(false);
	const [code, setCode] = useState("");
	const [cooldown, setCooldown] = useState(0);
	const [pwdMessage, setPwdMessage] = useState<string | null>(null);
	const forcedOnceRef = useRef(false);

	function maskEmail(email: string) {
		const [local, domain] = email.split("@");
		if (!local || !domain) {
			return email;
		}
		const prefix = local.slice(0, Math.min(2, local.length));
		return `${prefix}***@${domain}`;
	}

	function openPwdModal(reason?: string) {
		setShowPwdModal(true);
		setPwdMessage(reason ?? null);
		setCode("");
		try {
			sendFetcher.submit({ intent: "send" }, { method: "post", action: "/me/password-code" });
		} catch {
			setPwdMessage("发起验证码失败，请刷新页面后重试");
		}
	}

	function closePwdModal() {
		setShowPwdModal(false);
		setCode("");
		setPwdMessage(null);
		setCooldown(0);
	}

	useEffect(() => {
		const needVerify = searchParams.get("pwdVerify") === "1";
		if (!needVerify) {
			return;
		}
		openPwdModal("请先完成邮箱验证码验证");
		const next = new URLSearchParams(searchParams);
		next.delete("pwdVerify");
		setSearchParams(next, { replace: true });
	}, [searchParams, setSearchParams]);

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
		const data = sendFetcher.data;
		if (!data) {
			return;
		}
		if (data.ok && data.intent === "send") {
			setPwdMessage("验证码已发送，请查收邮箱");
			setCooldown(60);
			return;
		}
		if (data.ok === false && data.message) {
			setPwdMessage(String(data.message));
		}
	}, [sendFetcher.data]);

	useEffect(() => {
		const data = verifyFetcher.data;
		if (!data) {
			return;
		}
		if (data.ok && data.intent === "verify") {
			closePwdModal();
			try {
				navigate("/me/password");
			} catch {
				window.location.href = "/me/password";
			}
			return;
		}
		if (data.ok === false && data.message) {
			setPwdMessage(String(data.message));
		}
	}, [verifyFetcher.data, navigate]);

	useEffect(() => {
		if (!showPwdModal || cooldown <= 0) {
			return;
		}
		const timer = window.setInterval(() => {
			setCooldown((prev) => (prev > 0 ? prev - 1 : 0));
		}, 1000);
		return () => {
			window.clearInterval(timer);
		};
	}, [showPwdModal, cooldown]);

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
					<Link
						to="/posts"
						className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
					>
						返回论坛
					</Link>
				</header>

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
					{navError ? (
						<div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
							{navError}
						</div>
					) : null}
					<div className="mt-4 flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={() => {
								setNavError(null);
								openPwdModal();
							}}
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							修改密码
						</button>
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
			{showPwdModal ? (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
					<div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg dark:bg-gray-800">
						<h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">邮箱验证码验证</h3>
						<p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
							验证码将发送至：{maskEmail(me.email)}
						</p>

						{pwdMessage ? (
							<div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-200">
								{pwdMessage}
							</div>
						) : null}

						<div className="mt-4">
							<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
								验证码
							</label>
							<input
								value={code}
								onChange={(e) => {
									const raw = e.target.value;
									const next = raw.replace(/\D/g, "").slice(0, 6);
									setCode(next);
								}}
								inputMode="numeric"
								autoComplete="one-time-code"
								placeholder="请输入 6 位数字"
								className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
							/>
							<div className="mt-3 flex items-center justify-between gap-3">
								<button
									type="button"
									disabled={cooldown > 0 || sendFetcher.state !== "idle"}
									onClick={() => {
										setPwdMessage(null);
										sendFetcher.submit({ intent: "send" }, { method: "post", action: "/me/password-code" });
									}}
									className="text-sm text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline"
								>
									{cooldown > 0 ? `重新发送（${cooldown}s）` : "重新发送"}
								</button>
								<span className="text-xs text-gray-500 dark:text-gray-400">有效期 15 分钟</span>
							</div>
						</div>

						<div className="mt-6 flex items-center justify-end gap-3">
							<button
								type="button"
								onClick={closePwdModal}
								className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
							>
								取消
							</button>
							<button
								type="button"
								disabled={code.length !== 6 || verifyFetcher.state !== "idle"}
								onClick={() => {
									setPwdMessage(null);
									verifyFetcher.submit(
										{ intent: "verify", code },
										{ method: "post", action: "/me/password-code" },
									);
								}}
								className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
							>
								确认
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
