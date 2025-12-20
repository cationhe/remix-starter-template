import type { LinksFunction, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import {
	Link,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useLoaderData,
} from "@remix-run/react";

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
	return json<LoaderData>({ user });
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
			<body>
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
	const showAdmin = Boolean(user && (user.role === "admin" || user.role === "superadmin"));
	const isBanned = Boolean(user?.isBanned);

	return (
		<>
			<header className="sticky top-0 z-50 border-b border-gray-200 bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-900/80">
				<div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
					<div className="flex items-center gap-4">
						<Link
							to="/"
							className="text-sm font-semibold text-gray-900 hover:underline dark:text-gray-100"
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
										<Link
											to="/admin/attachments"
											className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
										>
											附件管理
										</Link>
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
									className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
								>
									登录
								</Link>
								<Link
									to="/register"
									className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
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
