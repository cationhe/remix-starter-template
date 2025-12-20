import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { changePassword, requireUser } from "~/lib/auth.server";

type ActionData = {
	fieldErrors?: {
		oldPassword?: string;
		newPassword?: string;
		confirmNewPassword?: string;
	};
	formError?: string;
};

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
};

function validatePasswordStrength(password: string) {
	if (password.length < 6) {
		return "密码长度至少为 6 位";
	}
	if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
		return "密码需要同时包含字母和数字";
	}
	return null;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	return json<LoaderData>({ me });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	const formData = await request.formData();
	const oldPassword = String(formData.get("oldPassword") || "");
	const newPassword = String(formData.get("newPassword") || "");
	const confirmNewPassword = String(formData.get("confirmNewPassword") || "");

	const fieldErrors: ActionData["fieldErrors"] = {};
	if (!oldPassword) {
		fieldErrors.oldPassword = "请输入旧密码";
	}
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

	if (fieldErrors.oldPassword || fieldErrors.newPassword || fieldErrors.confirmNewPassword) {
		return json<ActionData>({ fieldErrors }, { status: 400 });
	}

	try {
		await changePassword(context, me.id, oldPassword, newPassword);
		return redirect("/me/password?success=1");
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message === "OLD_PASSWORD_INCORRECT") {
			return json<ActionData>({ fieldErrors: { oldPassword: "旧密码不正确" } }, { status: 400 });
		}
		return json<ActionData>({ formError: "修改密码失败，请稍后重试" }, { status: 500 });
	}
}

export default function ChangePasswordPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	const [searchParams] = useSearchParams();
	const success = searchParams.get("success") === "1";

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-lg flex-col gap-6">
				<header className="flex items-start justify-between gap-4">
					<div>
						<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">修改密码</h1>
						<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
							当前账号：{data.me.displayName}
						</p>
					</div>
					<Link
						to="/me"
						className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
					>
						返回个人中心
					</Link>
				</header>

				{success ? (
					<div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-200">
						密码已修改
					</div>
				) : null}

				{actionData?.formError ? (
					<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						{actionData.formError}
					</div>
				) : null}

				<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
					<Form method="post" className="space-y-5">
						<div>
							<label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
								旧密码
							</label>
							<input
								name="oldPassword"
								type="password"
								required
								className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
							/>
							{actionData?.fieldErrors?.oldPassword ? (
								<p className="mt-1 text-xs text-red-600">{actionData.fieldErrors.oldPassword}</p>
							) : null}
						</div>
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
									至少 6 位，且同时包含字母和数字
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
							{isSubmitting ? "提交中..." : "确认修改"}
						</button>
					</Form>
				</section>
			</div>
		</div>
	);
}
