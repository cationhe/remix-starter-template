import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
	consumeRateLimit,
	getClientIp,
	getRateLimitState,
	promoteToSuperadminIfMatch,
	resetRateLimit,
	verifyLogin,
} from "~/lib/auth.server";
import { execute, getDBFromContext } from "~/lib/d1.server";
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

type LoaderData = {
	turnstileSiteKey: string | null;
	turnstileRenderEnabled: boolean;
	turnstileConfigured: boolean;
	turnstileEnforced: boolean;
};


function isLocalHostname(hostname: string) {
	const host = String(hostname || "").toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

function isTurnstileEnforced(context: any, request: Request) {
	const env = (context as any).cloudflare.env as any;
	const e2e = String(env?.E2E || "") === "1";
	const byHeader = request.headers.get("x-e2e-turnstile-enforce") === "1";
	const byVar = String(env?.TURNSTILE_ENFORCE || "") === "1";
	const siteKey = typeof env.TURNSTILE_SITE_KEY === "string" ? env.TURNSTILE_SITE_KEY.trim() : "";
	const secretKey = typeof env.TURNSTILE_SECRET_KEY === "string" ? env.TURNSTILE_SECRET_KEY.trim() : "";
	const configured = Boolean(siteKey && secretKey);
	if (e2e) return byHeader || byVar;
	if (byVar) return true;
	if (!configured) return false;
	let hostname = "";
	try {
		hostname = new URL(request.url).hostname;
	} catch {
		hostname = "";
	}
	return hostname ? !isLocalHostname(hostname) : true;
}

function getTurnstileConfig(context: any, request: Request) {
	const env = (context as any).cloudflare.env as any;
	const siteKey = typeof env.TURNSTILE_SITE_KEY === "string" ? env.TURNSTILE_SITE_KEY.trim() : "";
	const secretKey = typeof env.TURNSTILE_SECRET_KEY === "string" ? env.TURNSTILE_SECRET_KEY.trim() : "";
	const enforced = isTurnstileEnforced(context, request);
	const configured = Boolean(siteKey && secretKey);
	return {
		siteKey: siteKey || null,
		renderEnabled: Boolean(siteKey),
		configured,
		enforced,
	};
}

type TurnstileVerifyResponse = {
	success: boolean;
	"error-codes"?: string[];
	challenge_ts?: string;
	hostname?: string;
	action?: string;
	cdata?: string;
};

async function verifyTurnstileToken(args: {
	request: Request;
	context: ActionFunctionArgs["context"];
	responseToken: string;
	flow: "login" | "register";
	metadata: Record<string, unknown>;
}) {
	const cfg = getTurnstileConfig(args.context, args.request);
	if (!cfg.enforced) return { enabled: false, ok: true } as const;
	if (!cfg.configured) {
		const ip = getClientIp(args.request);
		const userAgent = args.request.headers.get("User-Agent");
		const now = Date.now();
		try {
			await execute(
				getDBFromContext(args.context),
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					0,
					"turnstile_misconfigured",
					ip,
					userAgent,
					JSON.stringify({ flow: args.flow, ...args.metadata }),
					now,
				],
			);
		} catch {
		}
		return { enabled: true, ok: false, message: "真人校验服务未正确配置，请稍后再试" } as const;
	}
	const env = (args.context as any).cloudflare.env as any;
	const secretKey = typeof env.TURNSTILE_SECRET_KEY === "string" ? env.TURNSTILE_SECRET_KEY.trim() : "";
	if (String(env?.E2E || "") === "1" && args.responseToken.startsWith("e2e_")) {
		return { enabled: true, ok: true } as const;
	}

	const ip = getClientIp(args.request);
	const userAgent = args.request.headers.get("User-Agent");
	const now = Date.now();
	const db = getDBFromContext(args.context);

	if (!args.responseToken) {
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[0, "turnstile_missing_token", ip, userAgent, JSON.stringify({ flow: args.flow, ...args.metadata }), now],
			);
		} catch {
		}
		return { enabled: true, ok: false, message: "请先完成人机验证" } as const;
	}

	let data: TurnstileVerifyResponse | null = null;
	try {
		const body = new URLSearchParams();
		body.set("secret", secretKey);
		body.set("response", args.responseToken);
		if (ip) body.set("remoteip", ip);
		const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
		});
		data = (await resp.json()) as TurnstileVerifyResponse;
	} catch {
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					0,
					"turnstile_verify_error",
					ip,
					userAgent,
					JSON.stringify({ flow: args.flow, reason: "request_failed", ...args.metadata }),
					now,
				],
			);
		} catch {
		}
		data = null;
	}

	if (!data?.success) {
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					0,
					"turnstile_verify_failed",
					ip,
					userAgent,
					JSON.stringify({
						flow: args.flow,
						errorCodes: Array.isArray(data?.["error-codes"]) ? data?.["error-codes"] : [],
						...args.metadata,
					}),
					now,
				],
			);
		} catch {
		}
		return { enabled: true, ok: false, message: "人机验证失败，请重试" } as const;
	}

	let requestHostname = "";
	try {
		requestHostname = new URL(args.request.url).hostname;
	} catch {
		requestHostname = "";
	}
	if (data.action && data.action !== args.flow) {
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					0,
					"turnstile_verify_rejected",
					ip,
					userAgent,
					JSON.stringify({ flow: args.flow, reason: "action_mismatch", action: data.action, ...args.metadata }),
					now,
				],
			);
		} catch {
		}
		return { enabled: true, ok: false, message: "人机验证失败，请重试" } as const;
	}
	if (data.hostname && requestHostname && data.hostname !== requestHostname) {
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					0,
					"turnstile_verify_rejected",
					ip,
					userAgent,
					JSON.stringify({
						flow: args.flow,
						reason: "hostname_mismatch",
						hostname: data.hostname,
						requestHostname,
						...args.metadata,
					}),
					now,
				],
			);
		} catch {
		}
		return { enabled: true, ok: false, message: "人机验证失败，请重试" } as const;
	}

	return { enabled: true, ok: true } as const;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const cfg = getTurnstileConfig(context, request);
	return json<LoaderData>({
		turnstileSiteKey: cfg.siteKey,
		turnstileRenderEnabled: cfg.renderEnabled,
		turnstileConfigured: cfg.configured,
		turnstileEnforced: cfg.enforced,
	});
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

	const turnstileToken = String(formData.get("cf-turnstile-response") || "").trim();
	const turnstile = await verifyTurnstileToken({
		request,
		context,
		responseToken: turnstileToken,
		flow: "login",
		metadata: { email: normalizedEmail },
	});
	if (turnstile.enabled && !turnstile.ok) {
		return json<ActionData>({ formError: turnstile.message }, { status: 400 });
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
	if (user.mustChangePassword) {
		try {
			await execute(
				getDBFromContext(context),
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					user.id,
					"login_force_pwd_change",
					ip,
					request.headers.get("User-Agent"),
					JSON.stringify({ tempPasswordExpiresAt: user.tempPasswordExpiresAt }),
					Date.now(),
				],
			);
		} catch {
		}
	}
	const session = await getSession(request, context);
	session.set("userId", user.id);
	const next = user.mustChangePassword ? "/me/password?force=1" : "/";
	return redirect(next, {
		headers: {
			"Set-Cookie": await commitSession(session, request, context),
		},
	});
}

export default function Login() {
	const loaderData = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	const [turnstileToken, setTurnstileToken] = useState("");
	const [turnstileScriptError, setTurnstileScriptError] = useState(false);
	const [turnstileWidgetError, setTurnstileWidgetError] = useState(false);
	const [searchParams] = useSearchParams();
	const resetSuccess = searchParams.get("reset") === "1";
	const turnstileRenderEnabled = loaderData.turnstileRenderEnabled;
	const turnstileConfigured = loaderData.turnstileConfigured;
	const turnstileEnforced = loaderData.turnstileEnforced;
	const turnstileSiteKey = loaderData.turnstileSiteKey;
	const turnstileMustPass = turnstileEnforced && turnstileConfigured;
	const turnstileBlocked =
		(turnstileMustPass && (!turnstileToken || turnstileWidgetError)) ||
		(turnstileEnforced && !turnstileConfigured);

	useEffect(() => {
		if (!turnstileRenderEnabled) return;
		(window as any).__turnstileLoginSuccess = (token: string) => {
			setTurnstileWidgetError(false);
			setTurnstileToken(String(token || ""));
		};
		(window as any).__turnstileLoginExpired = () => {
			setTurnstileToken("");
		};
		(window as any).__turnstileLoginError = () => {
			setTurnstileToken("");
			setTurnstileWidgetError(true);
		};
		setTurnstileScriptError(false);
		setTurnstileWidgetError(false);
		const src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
		const existed = Array.from(document.scripts).some((s) => s.src === src);
		if (existed) {
			return () => {
				delete (window as any).__turnstileLoginSuccess;
				delete (window as any).__turnstileLoginExpired;
				delete (window as any).__turnstileLoginError;
			};
		}
		const script = document.createElement("script");
		script.src = src;
		script.async = true;
		script.defer = true;
		script.crossOrigin = "anonymous";
		script.addEventListener("error", () => {
			setTurnstileScriptError(true);
			console.warn("Turnstile 脚本加载失败");
		});
		document.head.appendChild(script);
		return () => {
			delete (window as any).__turnstileLoginSuccess;
			delete (window as any).__turnstileLoginExpired;
			delete (window as any).__turnstileLoginError;
			script.remove();
		};
	}, [turnstileRenderEnabled]);

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
					{turnstileEnforced && !turnstileConfigured ? (
						<div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
							真人校验服务未正确配置，暂时无法登录，请稍后再试
						</div>
					) : null}
					{turnstileRenderEnabled ? (
						<div className="space-y-2">
							<div className="flex justify-center">
								<div
									className="cf-turnstile min-h-[65px] min-w-[300px]"
									data-sitekey={turnstileSiteKey ?? ""}
									data-theme="auto"
									data-action="login"
									data-response-field="false"
									data-callback="__turnstileLoginSuccess"
									data-expired-callback="__turnstileLoginExpired"
									data-error-callback="__turnstileLoginError"
								/>
							</div>
							<input type="hidden" name="cf-turnstile-response" value={turnstileToken} />
							{turnstileMustPass ? (
								turnstileToken ? null : (
									<p className="text-center text-xs text-gray-600 dark:text-gray-300">请完成人机验证后继续</p>
								)
							) : (
								<p className="text-center text-xs text-amber-700 dark:text-amber-200">
									真人验证当前未强制启用
								</p>
							)}
							{turnstileScriptError ? (
								<p className="text-center text-xs text-red-600">验证组件加载失败，请检查网络或刷新页面</p>
							) : null}
							{turnstileWidgetError ? (
								<p className="text-center text-xs text-red-600">验证失败，请刷新页面后重试</p>
							) : null}
						</div>
					) : turnstileEnforced ? (
						<div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
							真人校验服务未正确配置，暂时无法登录，请稍后再试
						</div>
					) : (
						<p className="text-center text-xs text-amber-700 dark:text-amber-200">
							真人验证未启用（缺少 Site Key），当前不会强制校验
						</p>
					)}
					<div>
						<label
							htmlFor="login-email"
							className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
						>
							邮箱
						</label>
						<input
							id="login-email"
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
						<label
							htmlFor="login-password"
							className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
						>
							密码
						</label>
						<input
							id="login-password"
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
						disabled={isSubmitting || turnstileBlocked}
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
