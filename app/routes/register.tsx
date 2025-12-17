import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { findUserByEmail, promoteToSuperadminIfMatch, registerUser } from "~/lib/auth.server";
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

export async function loader({}: LoaderFunctionArgs) {
	return json({});
}

export async function action({ request, context }: ActionFunctionArgs) {
	const formData = await request.formData();
	const email = String(formData.get("email") || "").trim();
	const displayName = String(formData.get("displayName") || "").trim();
	const password = String(formData.get("password") || "");
	const confirmPassword = String(formData.get("confirmPassword") || "");

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
				"Set-Cookie": await commitSession(session, context),
			},
		});
	} catch (error) {
		return json<ActionData>({ formError: "注册失败，请稍后重试" }, { status: 500 });
	}
}

export default function Register() {
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
			<div className="w-full max-w-md rounded-xl bg-white p-8 shadow dark:bg-gray-800">
				<h1 className="mb-6 text-center text-2xl font-semibold text-gray-900 dark:text-gray-100">
					注册账号
				</h1>
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
							昵称
						</label>
						<input
							name="displayName"
							required
							className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
						/>
						{actionData?.fieldErrors?.displayName ? (
							<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.displayName}</p>
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
					<div>
						<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
							确认密码
						</label>
						<input
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
						disabled={isSubmitting}
						className="flex w-full items-center justify-center rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
					>
						{isSubmitting ? "注册中..." : "注册"}
					</button>
				</Form>
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
