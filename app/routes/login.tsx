import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, useActionData, useNavigation, useSearchParams } from "@remix-run/react";
import {
	consumeRateLimit,
	getClientIp,
	getRateLimitState,
	promoteToSuperadminIfMatch,
	resetRateLimit,
	verifyLogin,
} from "~/lib/auth.server";
import { commitSession, getSession } from "~/lib/session.server";

type ActionData = {
	fieldErrors?: {
		email?: string;
		password?: string;
	};
	formError?: string;
	remainingAttempts?: number;
	lockedUntil?: number;
};

export async function loader({}: LoaderFunctionArgs) {
	return json({});
}

export async function action({ request, context }: ActionFunctionArgs) {
	const formData = await request.formData();
	const email = String(formData.get("email") || "").trim();
	const password = String(formData.get("password") || "");
	const ip = getClientIp(request);
	const normalizedEmail = email.trim().toLowerCase();
	const now = Date.now();

	const lockMs = 5 * 60 * 1000;
	const loginIpConfig = { windowMs: 30 * 60 * 1000, max: 10, blockMs: lockMs };
	const loginEmailConfig = { windowMs: 30 * 60 * 1000, max: 5, blockMs: lockMs };

	let blockedUntil: number | null = null;

	if (ip) {
		const state = await getRateLimitState(context, `login:ip:${ip}`, now);
		if (state.blockedUntil && state.blockedUntil > now) {
			blockedUntil = Math.max(blockedUntil ?? 0, state.blockedUntil);
		}
	}
	if (normalizedEmail) {
		const state = await getRateLimitState(context, `login:email:${normalizedEmail}`, now);
		if (state.blockedUntil && state.blockedUntil > now) {
			blockedUntil = Math.max(blockedUntil ?? 0, state.blockedUntil);
		}
	}
	if (blockedUntil && blockedUntil > now) {
		const retryAfterMinutes = Math.max(1, Math.ceil((blockedUntil - now) / (60 * 1000)));
		return json<ActionData>(
			{
				formError: `账号已锁定，请 ${retryAfterMinutes} 分钟后再试`,
				remainingAttempts: 0,
				lockedUntil: blockedUntil,
			},
			{ status: 429 },
		);
	}

	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!email) {
		fieldErrors.email = "请输入邮箱";
	}
	if (!password) {
		fieldErrors.password = "请输入密码";
	}
	if (fieldErrors.email || fieldErrors.password) {
		return json<ActionData>({ fieldErrors }, { status: 400 });
	}
	const user = await verifyLogin(context, email, password);
	if (!user) {
		let remainingAttempts: number | null = null;
		let nextBlockedUntil: number | null = null;
		if (ip) {
			const result = await consumeRateLimit(context, `login:ip:${ip}`, loginIpConfig, now);
			nextBlockedUntil = result.allowed
				? nextBlockedUntil
				: Math.max(nextBlockedUntil ?? 0, result.blockedUntil ?? 0);
			remainingAttempts = remainingAttempts === null ? result.remaining : Math.min(remainingAttempts, result.remaining);
		}
		if (normalizedEmail) {
			const result = await consumeRateLimit(
				context,
				`login:email:${normalizedEmail}`,
				loginEmailConfig,
				now,
			);
			nextBlockedUntil = result.allowed
				? nextBlockedUntil
				: Math.max(nextBlockedUntil ?? 0, result.blockedUntil ?? 0);
			remainingAttempts = remainingAttempts === null ? result.remaining : Math.min(remainingAttempts, result.remaining);
		}
		if (nextBlockedUntil && nextBlockedUntil > now) {
			const retryAfterMinutes = Math.max(1, Math.ceil((nextBlockedUntil - now) / (60 * 1000)));
			return json<ActionData>(
				{
					formError: `账号已锁定，请 ${retryAfterMinutes} 分钟后再试`,
					remainingAttempts: 0,
					lockedUntil: nextBlockedUntil,
				},
				{ status: 429 },
			);
		}
		const remaining = typeof remainingAttempts === "number" ? remainingAttempts : null;
		return json<ActionData>(
			{
				formError: "邮箱或密码错误",
				remainingAttempts: remaining ?? undefined,
			},
			{ status: 400 },
		);
	}
	if (ip) {
		await resetRateLimit(context, `login:ip:${ip}`, now);
	}
	if (normalizedEmail) {
		await resetRateLimit(context, `login:email:${normalizedEmail}`, now);
	}
	if (user.isBanned) {
		return json<ActionData>({ formError: "账号已被封禁" }, { status: 403 });
	}
	await promoteToSuperadminIfMatch(context, user.id);
	const session = await getSession(request, context);
	session.set("userId", user.id);
	return redirect("/", {
		headers: {
			"Set-Cookie": await commitSession(session, context),
		},
	});
}

export default function Login() {
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	const [searchParams] = useSearchParams();
	const resetSuccess = searchParams.get("reset") === "1";
	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
			<div className="w-full max-w-md rounded-xl bg-white p-8 shadow dark:bg-gray-800">
				<h1 className="mb-6 text-center text-2xl font-semibold text-gray-900 dark:text-gray-100">
					登录
				</h1>
				{resetSuccess ? (
					<div className="mb-5 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-200">
						密码已重置，请使用新密码登录
					</div>
				) : null}
				<Form method="post" className="space-y-5">
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
							邮箱
						</label>
						<input
							name="email"
							type="email"
							required
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.email ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.email}</p>
						) : null}
					</div>
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
							密码
						</label>
						<input
							name="password"
							type="password"
							required
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.password ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.password}</p>
						) : null}
					</div>
					{actionData?.formError ? (
						<div className="space-y-1">
							<p className="text-sm text-red-600">{actionData.formError}</p>
							{typeof actionData.remainingAttempts === "number" ? (
								<p className="text-sm text-red-600">您还有 {actionData.remainingAttempts} 次尝试机会</p>
							) : null}
						</div>
					) : null}
					<button
						type="submit"
						disabled={isSubmitting}
						className="flex w-full items-center justify-center rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
					>
						{isSubmitting ? "登录中..." : "登录"}
					</button>
				</Form>
				<div className="mt-4 flex items-center justify-between text-sm">
					<a href="/forgot-password" className="text-blue-600 hover:underline">
						忘记密码？
					</a>
					<a href="/register" className="text-blue-600 hover:underline">
						去注册
					</a>
				</div>
			</div>
		</div>
	);
}
