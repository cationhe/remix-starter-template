import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useMemo } from "react";
import { assertNotBanned, getClientIp, requireUser, verifyLogin } from "~/lib/auth.server";
import { getAttachmentStorageUsage, getSiteTotalStorageLimitBytes } from "~/lib/attachments.server";
import { attachmentStorageLimits, formatTotalStorageLimit, normalizeTotalStorageLimitBytes } from "~/lib/attachment-storage";
import { execute, getDBFromContext } from "~/lib/d1.server";

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	usage: Awaited<ReturnType<typeof getAttachmentStorageUsage>>;
};

type ActionData = {
	formError?: string;
};

function parseNumber(value: FormDataEntryValue | null) {
	const raw = typeof value === "string" ? value.trim() : "";
	const num = Number(raw);
	if (!raw || Number.isNaN(num) || !Number.isFinite(num)) return null;
	return num;
}

function formatBytes(bytes: number) {
	const n = Number(bytes);
	if (!Number.isFinite(n) || n < 0) return "0B";
	const gb = 1024 * 1024 * 1024;
	if (n >= gb) {
		const v = n / gb;
		return `${v.toFixed(2).replace(/\.00$/, "").replace(/(\d)0$/, "$1")}GB`;
	}
	const mb = 1024 * 1024;
	if (n >= mb) {
		const v = n / mb;
		return `${v.toFixed(1).replace(/\.0$/, "")}MB`;
	}
	const kb = 1024;
	if (n >= kb) {
		const v = n / kb;
		return `${v.toFixed(1).replace(/\.0$/, "")}KB`;
	}
	return `${Math.floor(n)}B`;
}

async function logEvent(args: {
	context: ActionFunctionArgs["context"];
	userId: number;
	eventType: string;
	ip: string | null;
	userAgent: string | null;
	metadata: Record<string, unknown>;
}) {
	try {
		await execute(
			getDBFromContext(args.context),
			"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			[args.userId, args.eventType, args.ip, args.userAgent, JSON.stringify(args.metadata), Date.now()],
		);
	} catch {
	}
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (me.role !== "superadmin" && me.role !== "topadmin") {
		throw new Response("只有超级管理员或站点管理员可访问", { status: 403 });
	}
	const usage = await getAttachmentStorageUsage(context);
	return json<LoaderData>({ me, usage });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (me.role !== "superadmin" && me.role !== "topadmin") {
		return json<ActionData>({ formError: "只有超级管理员或站点管理员可访问" }, { status: 403 });
	}

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "");
	if (intent !== "setTotalLimit") {
		return json<ActionData>({ formError: "未知操作" }, { status: 400 });
	}

	const password = String(formData.get("password") || "").trim();
	if (!password) {
		return json<ActionData>({ formError: "需要二次验证密码" }, { status: 400 });
	}
	const verified = await verifyLogin(context, me.email, password);
	if (!verified || verified.id !== me.id) {
		return json<ActionData>({ formError: "二次验证失败" }, { status: 403 });
	}

	const limitGb = parseNumber(formData.get("limitGb"));
	if (limitGb === null) {
		return json<ActionData>({ formError: "请输入有效的容量数值" }, { status: 400 });
	}
	const nextBytes = normalizeTotalStorageLimitBytes(limitGb * 1024 * 1024 * 1024);
	const prevBytes = await getSiteTotalStorageLimitBytes(context);

	const db = getDBFromContext(context);
	const now = Date.now();
	try {
		await execute(
			db,
			"INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
			[attachmentStorageLimits.TOTAL_STORAGE_LIMIT_SETTING_KEY, JSON.stringify(nextBytes), now],
		);
		await logEvent({
			context,
			userId: me.id,
			eventType: "site_total_storage_limit_updated",
			ip: getClientIp(request),
			userAgent: request.headers.get("User-Agent"),
			metadata: { operatorRole: me.role, prevBytes, nextBytes },
		});
		return redirect("/admin/storage");
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		await logEvent({
			context,
			userId: me.id,
			eventType: "site_total_storage_limit_update_failed",
			ip: getClientIp(request),
			userAgent: request.headers.get("User-Agent"),
			metadata: { operatorRole: me.role, prevBytes, nextBytes, message },
		});
		if (message.includes("no such table") || message.includes("no such column")) {
			return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
		}
		return json<ActionData>({ formError: "保存失败，请稍后重试" }, { status: 500 });
	}
}

export default function AdminStoragePage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const usage = data.usage;
	const limitGbValue = useMemo(() => {
		const gb = usage.limitBytes / (1024 * 1024 * 1024);
		return Number.isFinite(gb) ? String(gb) : "";
	}, [usage.limitBytes]);

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<header className="flex items-center justify-between">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">存储容量管理</h1>
					<div className="flex items-center gap-2">
						<Link
							to="/admin/discussion-areas"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							讨论区管理
						</Link>
						<Link
							to="/posts"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							返回论坛
						</Link>
					</div>
				</header>

				{actionData?.formError ? (
					<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						{actionData.formError}
					</div>
				) : null}

				<div className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
					<div className="grid gap-3 sm:grid-cols-3">
						<div className="rounded border border-gray-200 p-3 dark:border-gray-700">
							<div className="text-xs text-gray-500 dark:text-gray-400">已使用</div>
							<div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
								{formatBytes(usage.usedBytes)}
							</div>
						</div>
						<div className="rounded border border-gray-200 p-3 dark:border-gray-700">
							<div className="text-xs text-gray-500 dark:text-gray-400">预留（上传中）</div>
							<div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
								{formatBytes(usage.reservedBytes)}
							</div>
						</div>
						<div className="rounded border border-gray-200 p-3 dark:border-gray-700">
							<div className="text-xs text-gray-500 dark:text-gray-400">总上限</div>
							<div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
								{formatTotalStorageLimit(usage.limitBytes)}
							</div>
						</div>
					</div>

					{usage.paused ? (
						<div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
							当前存储已接近或达到上限，系统会暂停新的附件上传。
						</div>
					) : (
						<div className="mt-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-200">
							当前存储未达到上限，附件上传处于可用状态。
						</div>
					)}
				</div>

				<div className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
					<div className="text-sm font-medium text-gray-900 dark:text-gray-100">调整网站总存储上限</div>
					<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
						范围：{formatTotalStorageLimit(attachmentStorageLimits.MIN_TOTAL_STORAGE_LIMIT_BYTES)}～
						{formatTotalStorageLimit(attachmentStorageLimits.MAX_TOTAL_STORAGE_LIMIT_BYTES)}，步进：
						{formatBytes(attachmentStorageLimits.TOTAL_STORAGE_LIMIT_STEP_BYTES)}。
					</div>

					<Form method="post" className="mt-4 grid gap-3 sm:grid-cols-2">
						<input type="hidden" name="intent" value="setTotalLimit" />
						<div>
							<label className="block text-sm font-medium text-gray-700 dark:text-gray-200">上限（GB）</label>
							<input
								name="limitGb"
								type="number"
								min={attachmentStorageLimits.MIN_TOTAL_STORAGE_LIMIT_BYTES / (1024 * 1024 * 1024)}
								max={attachmentStorageLimits.MAX_TOTAL_STORAGE_LIMIT_BYTES / (1024 * 1024 * 1024)}
								step={attachmentStorageLimits.TOTAL_STORAGE_LIMIT_STEP_BYTES / (1024 * 1024 * 1024)}
								defaultValue={limitGbValue}
								className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
							/>
						</div>
						<div>
							<label className="block text-sm font-medium text-gray-700 dark:text-gray-200">二次验证密码</label>
							<input
								name="password"
								type="password"
								placeholder="请输入你的账号密码"
								className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
							/>
						</div>
						<div className="sm:col-span-2 flex items-center justify-end">
							<button
								type="submit"
								disabled={navigation.state !== "idle"}
								className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
							>
								{navigation.state === "idle" ? "保存" : "保存中..."}
							</button>
						</div>
					</Form>
				</div>
			</div>
		</div>
	);
}

