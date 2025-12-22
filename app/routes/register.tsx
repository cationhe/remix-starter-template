import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
	consumeRateLimit,
	findUserByEmail,
	getRegistrationPaused,
	getClientIp,
	promoteToSuperadminIfMatch,
	registerUser,
} from "~/lib/auth.server";
import { execute, getDBFromContext } from "~/lib/d1.server";
import { commitSession, getSession } from "~/lib/session.server";

type ActionData = {
	fieldErrors?: {
		email?: string;
		displayName?: string;
		password?: string;
		confirmPassword?: string;
	};
	formError?: string;
};

type LoaderData = {
	registrationPaused: boolean;
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
	if (e2e) return byHeader || byVar;
	if (byVar) return true;
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
	const registrationPaused = await getRegistrationPaused(context);
	const cfg = getTurnstileConfig(context, request);
	return json<LoaderData>({
		registrationPaused,
		turnstileSiteKey: cfg.siteKey,
		turnstileRenderEnabled: cfg.renderEnabled,
		turnstileConfigured: cfg.configured,
		turnstileEnforced: cfg.enforced,
	});
}

export async function action({ request, context }: ActionFunctionArgs) {
	const registrationPaused = await getRegistrationPaused(context);
	if (registrationPaused) {
		return json<ActionData>({ formError: "当前暂停注册，系统维护中，请稍后再试" }, { status: 403 });
	}

	const formData = await request.formData();
	const email = String(formData.get("email") || "").trim();
	const displayName = String(formData.get("displayName") || "").trim();
	const password = String(formData.get("password") || "");
	const confirmPassword = String(formData.get("confirmPassword") || "");
	const ip = getClientIp(request);
	const normalizedEmail = email.trim().toLowerCase();
	const now = Date.now();

	const turnstileToken = String(formData.get("cf-turnstile-response") || "").trim();
	const turnstile = await verifyTurnstileToken({
		request,
		context,
		responseToken: turnstileToken,
		flow: "register",
		metadata: { email: normalizedEmail },
	});
	if (turnstile.enabled && !turnstile.ok) {
		return json<ActionData>({ formError: turnstile.message }, { status: 400 });
	}

	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!email) {
		fieldErrors.email = "请输入邮箱";
	}
	if (!displayName) {
		fieldErrors.displayName = "请输入昵称";
	}
	if (!password) {
		fieldErrors.password = "请输入密码";
	}
	if (password && password.length < 6) {
		fieldErrors.password = "密码长度至少为 6 位";
	}
	if (password !== confirmPassword) {
		fieldErrors.confirmPassword = "两次输入的密码不一致";
	}
	if (fieldErrors.email || fieldErrors.displayName || fieldErrors.password || fieldErrors.confirmPassword) {
		return json<ActionData>({ fieldErrors }, { status: 400 });
	}

	const registerIpConfig = { windowMs: 60 * 60 * 1000, max: 5, blockMs: 60 * 60 * 1000 };
	const registerEmailConfig = { windowMs: 60 * 60 * 1000, max: 3, blockMs: 60 * 60 * 1000 };
	if (ip) {
		const result = await consumeRateLimit(context, `register:ip:${ip}`, registerIpConfig, now);
		if (!result.allowed && result.blockedUntil && result.blockedUntil > now) {
			const retryAfterSeconds = Math.max(1, Math.ceil((result.blockedUntil - now) / 1000));
			return json<ActionData>(
				{ formError: `注册过于频繁，请在 ${retryAfterSeconds} 秒后再试` },
				{ status: 429 },
			);
		}
	}
	if (normalizedEmail) {
		const result = await consumeRateLimit(
			context,
			`register:email:${normalizedEmail}`,
			registerEmailConfig,
			now,
		);
		if (!result.allowed && result.blockedUntil && result.blockedUntil > now) {
			const retryAfterSeconds = Math.max(1, Math.ceil((result.blockedUntil - now) / 1000));
			return json<ActionData>(
				{ formError: `注册过于频繁，请在 ${retryAfterSeconds} 秒后再试` },
				{ status: 429 },
			);
		}
	}

	const existing = await findUserByEmail(context, email);
	if (existing) {
		return json<ActionData>(
			{
				fieldErrors: {
					email: "该邮箱已被注册",
				},
			},
			{ status: 400 },
		);
	}

	try {
		const user = await registerUser(context, email, displayName, password);
		await promoteToSuperadminIfMatch(context, user.id);
		const session = await getSession(request, context);
		session.set("userId", user.id);
		return redirect("/", {
			headers: {
				"Set-Cookie": await commitSession(session, request, context),
			},
		});
	} catch (error) {
		return json<ActionData>({ formError: "注册失败，请稍后重试" }, { status: 500 });
	}
}

export default function Register() {
	const loaderData = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	const [turnstileToken, setTurnstileToken] = useState("");
	const [turnstileScriptError, setTurnstileScriptError] = useState(false);
	const [turnstileWidgetError, setTurnstileWidgetError] = useState(false);
	const registrationPaused = loaderData.registrationPaused;
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
		(window as any).__turnstileRegisterSuccess = (token: string) => {
			setTurnstileWidgetError(false);
			setTurnstileToken(String(token || ""));
		};
		(window as any).__turnstileRegisterExpired = () => {
			setTurnstileToken("");
		};
		(window as any).__turnstileRegisterError = () => {
			setTurnstileToken("");
			setTurnstileWidgetError(true);
		};
		setTurnstileScriptError(false);
		setTurnstileWidgetError(false);
		const src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
		const existed = Array.from(document.scripts).some((s) => s.src === src);
		if (existed) {
			return () => {
				delete (window as any).__turnstileRegisterSuccess;
				delete (window as any).__turnstileRegisterExpired;
				delete (window as any).__turnstileRegisterError;
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
			delete (window as any).__turnstileRegisterSuccess;
			delete (window as any).__turnstileRegisterExpired;
			delete (window as any).__turnstileRegisterError;
			script.remove();
		};
	}, [turnstileRenderEnabled]);

	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
			<div className="w-full max-w-md rounded-xl bg-white p-8 shadow dark:bg-gray-800">
				<h1 className="mb-6 text-center text-2xl font-semibold text-gray-900 dark:text-gray-100">
					注册账号
				</h1>
				{registrationPaused ? (
					<div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
						<div className="font-medium">当前暂停注册</div>
						<div className="mt-1">系统维护中，请稍后再试。</div>
						<div className="mt-3 flex items-center gap-3">
							<a href="/login" className="text-blue-600 hover:underline dark:text-blue-400">
								去登录
							</a>
							<a href="/" className="text-blue-600 hover:underline dark:text-blue-400">
								返回首页
							</a>
						</div>
					</div>
				) : (
					<Form method="post" className="space-y-5">
						{turnstileEnforced && !turnstileConfigured ? (
							<div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
								真人校验服务未正确配置，暂时无法注册，请稍后再试
							</div>
						) : null}
						{turnstileRenderEnabled ? (
							<div className="space-y-2">
								<div className="flex justify-center">
									<div
									className="cf-turnstile min-h-[65px] min-w-[300px]"
									data-sitekey={turnstileSiteKey ?? ""}
									data-theme="auto"
									data-action="register"
									data-response-field="false"
									data-callback="__turnstileRegisterSuccess"
									data-expired-callback="__turnstileRegisterExpired"
									data-error-callback="__turnstileRegisterError"
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
								真人校验服务未正确配置，暂时无法注册，请稍后再试
							</div>
						) : (
							<p className="text-center text-xs text-amber-700 dark:text-amber-200">
								真人验证未启用（缺少 Site Key），当前不会强制校验
							</p>
						)}
						<div>
							<label
								htmlFor="register-email"
								className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
							>
							邮箱
						</label>
						<input
							id="register-email"
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
							htmlFor="register-display-name"
							className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
						>
							昵称
						</label>
						<input
							id="register-display-name"
							name="displayName"
							required
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.displayName ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.displayName}</p>
						) : null}
					</div>
					<div>
						<label
							htmlFor="register-password"
							className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
						>
							密码
						</label>
						<input
							id="register-password"
							name="password"
							type="password"
							required
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.password ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.password}</p>
						) : null}
					</div>
					<div>
						<label
							htmlFor="register-confirm-password"
							className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
						>
							确认密码
						</label>
						<input
							id="register-confirm-password"
							name="confirmPassword"
							type="password"
							required
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.confirmPassword ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.confirmPassword}</p>
						) : null}
					</div>
					{actionData?.formError ? (
						<p className="text-sm text-red-600">{actionData.formError}</p>
					) : null}
						<button
							type="submit"
							disabled={isSubmitting || turnstileBlocked}
							className="flex w-full items-center justify-center rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
						>
							{isSubmitting ? "注册中..." : "注册"}
						</button>
					</Form>
				)}
				<p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-300">
					已有账号？
					<a href="/login" className="ml-1 text-blue-600 hover:underline">
						去登录
					</a>
				</p>
			</div>
		</div>
	);
}
