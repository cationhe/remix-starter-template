import type { LinksFunction, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import {
	Link,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useFetcher,
	useLoaderData,
} from "@remix-run/react";

import { useEffect } from "react";

import { findUserById } from "~/lib/auth.server";
import { getSession } from "~/lib/session.server";

import "./tailwind.css";

export const links: LinksFunction = () => [];

type LoaderData = {
	user: Awaited<ReturnType<typeof findUserById>>;
};

export async function loader({ request, context }: LoaderFunctionArgs) {
	const session = await getSession(request, context);
	const userId = session.get("userId") as number | undefined;
	let user: Awaited<ReturnType<typeof findUserById>> = null;
	if (userId) {
		user = await findUserById(context, userId);
	}
	if (user?.mustChangePassword) {
		const pathname = new URL(request.url).pathname;
		const allowed =
			pathname === "/me" ||
			pathname === "/me/password" ||
			pathname === "/me/password-code" ||
			pathname === "/logout";
		if (!allowed) {
			throw redirect("/me/password?force=1");
		}
	}
	return json<LoaderData>(
		{ user },
		{
			headers: {
				"Cache-Control": "no-store",
				Vary: "Cookie",
			},
		},
	);
}

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<Meta />
				<Links />
			</head>
			<body className="min-h-screen bg-slate-50 bg-grid-slate-100 dark:bg-slate-950 dark:bg-grid-slate-900">
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export default function App() {
	const data = useLoaderData<typeof loader>();
	const user = data.user;
	const showAdmin = Boolean(user && (user.role === "admin" || user.role === "superadmin" || user.role === "topadmin"));
	const isBanned = Boolean(user?.isBanned);
	const unreadFetcher = useFetcher<{ unreadCount: number }>();
	const unreadCount = user && !isBanned ? Number(unreadFetcher.data?.unreadCount ?? 0) : 0;

	useEffect(() => {
		if (!user || isBanned) return;

		let active = true;
		const loadUnread = () => {
			if (!active) return;
			if (unreadFetcher.state !== "idle") return;
			unreadFetcher.load("/api/messages/unread");
		};

		loadUnread();
		const intervalId = setInterval(loadUnread, 3000);
		const onVisibility = () => {
			if (document.visibilityState === "visible") {
				loadUnread();
			}
		};
		const onRefresh = () => loadUnread();

		window.addEventListener("focus", loadUnread);
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("messages-unread-refresh", onRefresh);

		return () => {
			active = false;
			clearInterval(intervalId);
			window.removeEventListener("focus", loadUnread);
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("messages-unread-refresh", onRefresh);
		};
	}, [user, isBanned, unreadFetcher]);

	return (
		<>
			<header className="sticky top-0 z-50 border-b border-slate-200/60 bg-white/80 backdrop-blur-md dark:border-slate-800/60 dark:bg-slate-950/80 border-t-4 border-t-blue-500 shadow-md transition-all duration-300">
				<div className="mx-auto flex max-w-screen-xl items-center justify-between px-6 py-3">
					<div className="flex items-center gap-4">
						<Link
							to="/"
							className="text-base font-bold text-gray-900 transition-colors hover:text-primary-600 dark:text-gray-100 dark:hover:text-primary-400"
						>
							AI传感器编程学习论坛
						</Link>
						<Link
							to="/posts"
							className="text-sm text-gray-600 hover:underline dark:text-gray-300"
						>
							论坛
						</Link>
					</div>
					<nav className="flex items-center gap-3 text-sm">
						{user ? (
							<>
								<span className="text-gray-700 dark:text-gray-200">
									{user.displayName}（{user.role}）
								</span>
								{isBanned ? (
									<span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-200">
										已封禁
									</span>
								) : null}
								<Link
									to="/messages"
									className="relative inline-flex items-center rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
									aria-label={unreadCount > 0 ? `消息中心，${unreadCount} 条未读` : "消息中心"}
								>
									消息中心
									{unreadCount > 0 ? (
										<span className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold leading-5 text-white">
											{unreadCount > 99 ? "99+" : unreadCount}
										</span>
									) : null}
								</Link>
								<Link
									to="/me"
									className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
								>
									个人中心
								</Link>
								{showAdmin ? (
									<>
										<Link
											to="/admin/users"
											className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										>
											用户管理
										</Link>
										{user.role === "superadmin" || user.role === "topadmin" ? (
											<>
												<Link
													to="/admin/posts/bulk-delete"
													className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
												>
													批量删除封禁
												</Link>
												<Link
													to="/admin/nickname-requests"
													className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
												>
													昵称审批
												</Link>
												<Link
													to="/admin/discussion-areas"
													className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
												>
													讨论区管理
												</Link>
												<Link
													to="/admin/storage"
													className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
												>
													存储容量
												</Link>
												{user.role === "topadmin" ? (
													<Link
														to="/admin/system-logs"
														className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
													>
														系统日志
													</Link>
												) : null}
											</>
										) : null}
									</>
								) : null}
								<Link
									to="/logout"
									className="rounded bg-gray-800 px-3 py-1 text-white hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
								>
									退出
								</Link>
							</>
						) : (
							<>
								<Link
									to="/login"
									className="rounded-md border border-gray-200 px-4 py-1.5 text-sm font-medium text-gray-700 transition-all hover:border-primary-400 hover:text-primary-600 hover:shadow-sm dark:border-gray-700 dark:text-gray-200 dark:hover:border-primary-500 dark:hover:text-primary-400"
								>
									登录
								</Link>
								<Link
									to="/register"
									className="rounded-md bg-primary-600 px-4 py-1.5 text-sm font-medium text-white transition-all hover:bg-primary-700 hover:shadow-md hover:shadow-primary-500/20 dark:bg-primary-600 dark:hover:bg-primary-500"
								>
									注册
								</Link>
							</>
						)}
					</nav>
				</div>
			</header>
			<Outlet />
		</>
	);
}
