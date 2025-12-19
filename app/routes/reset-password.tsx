import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { setPasswordByUserId } from "~/lib/auth.server";
import { execute, getDBFromContext, queryOne } from "~/lib/d1.server";

type ResetRecord = {
	id: number;
	userId: number;
	expiresAt: number;
	usedAt: number | null;
};

type LoaderData = {
	valid: boolean;
};

type ActionData = {
	fieldErrors?: {
		newPassword?: string;
		confirmNewPassword?: string;
	};
	formError?: string;
};

function toHex(data: Uint8Array) {
	return Array.from(data)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function sha256(input: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return toHex(new Uint8Array(hashBuffer));
}

function validatePasswordStrength(password: string) {
	if (password.length < 8) {
		return "密码长度至少为 8 位";
	}
	if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
		return "密码需要同时包含字母和数字";
	}
	return null;
}

async function findValidReset(db: ReturnType<typeof getDBFromContext>, tokenHash: string, now: number) {
	const record = await queryOne<ResetRecord>(
		db,
		"SELECT id as id, user_id as userId, expires_at as expiresAt, used_at as usedAt FROM password_resets WHERE token_hash = ? LIMIT 1",
		[tokenHash],
	);
	if (!record) return null;
	if (record.usedAt) return null;
	if (record.expiresAt <= now) return null;
	return record;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const url = new URL(request.url);
	const token = String(url.searchParams.get("token") || "").trim();
	if (!token) {
		return json<LoaderData>({ valid: false });
	}
	const tokenHash = await sha256(`reset:${token}`);
	const now = Date.now();
	const db = getDBFromContext(context);
	const reset = await findValidReset(db, tokenHash, now);
	return json<LoaderData>({ valid: Boolean(reset) });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const url = new URL(request.url);
	const token = String(url.searchParams.get("token") || "").trim();
	if (!token) {
		return json<ActionData>({ formError: "无效的重置链接" }, { status: 400 });
	}
	const tokenHash = await sha256(`reset:${token}`);
	const formData = await request.formData();
	const newPassword = String(formData.get("newPassword") || "");
	const confirmNewPassword = String(formData.get("confirmNewPassword") || "");

	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!newPassword) {
		fieldErrors.newPassword = "请输入新密码";
	}
	if (newPassword) {
		const strengthError = validatePasswordStrength(newPassword);
		if (strengthError) {
			fieldErrors.newPassword = strengthError;
		}
	}
	if (newPassword !== confirmNewPassword) {
		fieldErrors.confirmNewPassword = "两次输入的新密码不一致";
	}
	if (fieldErrors.newPassword || fieldErrors.confirmNewPassword) {
		return json<ActionData>({ fieldErrors }, { status: 400 });
	}

	const now = Date.now();
	const db = getDBFromContext(context);
	const reset = await findValidReset(db, tokenHash, now);
	if (!reset) {
		return json<ActionData>({ formError: "重置链接已失效，请重新发起" }, { status: 400 });
	}

	try {
		await setPasswordByUserId(context, reset.userId, newPassword);
		await execute(db, "UPDATE password_resets SET used_at = ? WHERE id = ?", [now, reset.id]);
		return redirect("/login?reset=1");
	} catch (error) {
		return json<ActionData>({ formError: "重置失败，请稍后重试" }, { status: 500 });
	}
}

export default function ResetPasswordPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";

	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
			<div className="w-full max-w-md rounded-xl bg-white p-8 shadow dark:bg-gray-800">
				<h1 className="mb-6 text-center text-2xl font-semibold text-gray-900 dark:text-gray-100">
					重置密码
				</h1>

				{!data.valid ? (
					<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						重置链接无效或已过期。
						<div className="mt-2">
							<Link to="/forgot-password" className="text-blue-600 hover:underline">
								重新获取重置邮件
							</Link>
						</div>
					</div>
				) : (
					<>
						{actionData?.formError ? (
							<div className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
								{actionData.formError}
							</div>
						) : null}
						<Form method="post" className="space-y-5">
							<div>
								<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
									新密码
								</label>
								<input
									name="newPassword"
									type="password"
									required
									className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
								/>
								{actionData?.fieldErrors?.newPassword ? (
									<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.newPassword}</p>
								) : (
									<p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
										至少 8 位，且同时包含字母和数字
									</p>
								)}
							</div>
							<div>
								<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
									确认新密码
								</label>
								<input
									name="confirmNewPassword"
									type="password"
									required
									className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
								/>
								{actionData?.fieldErrors?.confirmNewPassword ? (
									<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.confirmNewPassword}</p>
								) : null}
							</div>
							<button
								type="submit"
								disabled={isSubmitting}
								className="flex w-full items-center justify-center rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
							>
								{isSubmitting ? "提交中..." : "设置新密码"}
							</button>
						</Form>
					</>
				)}

				<div className="mt-5 text-center text-sm">
					<Link to="/login" className="text-blue-600 hover:underline">
						返回登录
					</Link>
				</div>
			</div>
		</div>
	);
}
