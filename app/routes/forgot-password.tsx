import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useNavigation } from "@remix-run/react";
import { findUserByEmail, sendEmail } from "~/lib/auth.server";
import { execute, getDBFromContext } from "~/lib/d1.server";

type ActionData = {
	fieldErrors?: {
		email?: string;
	};
	formError?: string;
	ok?: boolean;
};

function toHex(data: Uint8Array) {
	return Array.from(data)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function randomTokenHex(size: number) {
	const bytes = new Uint8Array(size);
	crypto.getRandomValues(bytes);
	return toHex(bytes);
}

async function sha256(input: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return toHex(new Uint8Array(hashBuffer));
}


export async function loader({}: LoaderFunctionArgs) {
	return json({});
}

export async function action({ request, context }: ActionFunctionArgs) {
	const formData = await request.formData();
	const email = String(formData.get("email") || "").trim();

	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!email) {
		fieldErrors.email = "请输入邮箱";
	}
	if (fieldErrors.email) {
		return json<ActionData>({ fieldErrors }, { status: 400 });
	}

	const user = await findUserByEmail(context, email);
	if (user) {
		const env = (context as any).cloudflare?.env as any;
		const baseUrl = String(env?.PUBLIC_BASE_URL || "")
			.trim()
			.replace(/\/$/, "");
		if (!baseUrl) {
			return json<ActionData>({ formError: "站点地址未配置" }, { status: 500 });
		}
		const token = randomTokenHex(32);
		const tokenHash = await sha256(`reset:${token}`);
		const now = Date.now();
		const expiresAt = now + 60 * 60 * 1000;
		const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || null;

		const db = getDBFromContext(context);
		await execute(
			db,
			"INSERT INTO password_resets (user_id, token_hash, expires_at, used_at, created_at, requested_ip) VALUES (?, ?, ?, NULL, ?, ?)",
			[user.id, tokenHash, expiresAt, now, ip],
		);

		const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
		try {
			await sendEmail(context, {
				to: user.email,
				subject: "重置密码",
				text: `你正在重置论坛账号密码。请在 60 分钟内打开链接并设置新密码：\n\n${resetUrl}\n\n如果不是你本人操作，请忽略这封邮件。`,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (message === "EMAIL_NOT_CONFIGURED") {
				return json<ActionData>({ formError: "邮件服务未配置" }, { status: 500 });
			}
			if (message === "EMAIL_SEND_FAILED") {
				const status = typeof (error as any)?.status === "number" ? Number((error as any).status) : 0;
				const detail = typeof (error as any)?.detail === "string" ? String((error as any).detail) : "";
				const detailLower = detail.toLowerCase();
				const triedFallback = detailLower.includes("fallback:");
				if (status === 401) {
					return json<ActionData>(
						{ formError: triedFallback ? "RESEND_API_KEY 无效或无权限（已尝试回退发送仍失败）" : "RESEND_API_KEY 无效或无权限" },
						{ status: 500 },
					);
				}
				if (status === 403) {
					return json<ActionData>(
						{
							formError: triedFallback
								? "发件域名未验证或 EMAIL_FROM 不被允许（已尝试回退发送仍失败）"
								: "发件域名未验证或 EMAIL_FROM 不被允许",
						},
						{ status: 500 },
					);
				}
				if (status === 422) {
					return json<ActionData>(
						{ formError: triedFallback ? "EMAIL_FROM 配置不正确（已尝试回退发送仍失败）" : "EMAIL_FROM 配置不正确" },
						{ status: 500 },
					);
				}
				if (status === 429) {
					return json<ActionData>({ formError: "发送过于频繁，请稍后再试" }, { status: 500 });
				}
				if (detailLower.includes("invalid api key") || detailLower.includes("unauthorized")) {
					return json<ActionData>({ formError: "RESEND_API_KEY 无效或无权限" }, { status: 500 });
				}
				if (
					detailLower.includes("domain") &&
					(detailLower.includes("verify") || detailLower.includes("verified") || detailLower.includes("not allowed"))
				) {
					return json<ActionData>({ formError: "发件域名未验证或 EMAIL_FROM 不被允许" }, { status: 500 });
				}
				if (detailLower.includes("from") && (detailLower.includes("invalid") || detailLower.includes("missing"))) {
					return json<ActionData>({ formError: "EMAIL_FROM 配置不正确" }, { status: 500 });
				}
				const compactDetail = detail
					.replace(/\s+/g, " ")
					.replace(/\u0000/g, "")
					.slice(0, 300)
					.trim();
				return json<ActionData>(
					{
						formError: compactDetail
							? `邮件发送失败，请检查 Resend 域名验证与发件人配置（错误详情：${compactDetail}）`
							: "邮件发送失败，请检查 Resend 域名验证与发件人配置",
					},
					{ status: 500 },
				);
			}
			return json<ActionData>({ formError: "邮件发送失败，请稍后重试" }, { status: 500 });
		}
	}

	return json<ActionData>({ ok: true });
}

export default function ForgotPasswordPage() {
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";

	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
			<div className="w-full max-w-md rounded-xl bg-white p-8 shadow dark:bg-gray-800">
				<h1 className="mb-2 text-center text-2xl font-semibold text-gray-900 dark:text-gray-100">
					忘记密码
				</h1>
				<p className="mb-6 text-center text-sm text-gray-600 dark:text-gray-300">
					输入邮箱后，如果账号存在，将发送重置链接。
				</p>

				{actionData?.ok ? (
					<div className="mb-5 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-200">
						如果邮箱存在，将收到重置邮件。
					</div>
				) : null}
				{actionData?.formError ? (
					<div className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						{actionData.formError}
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
					<button
						type="submit"
						disabled={isSubmitting}
						className="flex w-full items-center justify-center rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
					>
						{isSubmitting ? "发送中..." : "发送重置邮件"}
					</button>
				</Form>

				<div className="mt-5 text-center text-sm">
					<Link to="/login" className="text-blue-600 hover:underline">
						返回登录
					</Link>
				</div>
			</div>
		</div>
	);
}
