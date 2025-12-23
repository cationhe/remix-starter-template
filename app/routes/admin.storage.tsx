import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import { assertNotBanned, getClientIp, requireUser, verifyLogin } from "~/lib/auth.server";
import { execute, getDBFromContext } from "~/lib/d1.server";
import {
	attachmentStorageLimits,
	formatTotalStorageLimit,
	normalizeTotalStorageLimitBytes,
} from "~/lib/attachment-storage";
import {
	getAttachmentStorageUsage,
} from "~/lib/attachments.server";

type ActionData = {
	formError?: string;
};

function formatSize(bytes: number) {
	if (!Number.isFinite(bytes) || bytes < 0) return "-";
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1)} MB`;
	const gb = mb / 1024;
	return `${gb.toFixed(2)} GB`;
}

function toStepGb(value: number) {
	if (!Number.isFinite(value)) return 5;
	return Math.round(value * 2) / 2;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (me.role !== "superadmin") {
		throw new Response("只有超级管理员可访问", { status: 403 });
	}
	const usage = await getAttachmentStorageUsage(context);
	return json({ me, usage });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (me.role !== "superadmin") {
		return json<ActionData>({ formError: "只有超级管理员可以修改存储容量" }, { status: 403 });
	}

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "");
	if (intent !== "setTotalStorageLimit") {
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

	const gbRaw = String(formData.get("limitGb") || "").trim();
	const gb = Number(gbRaw);
	if (!gbRaw || Number.isNaN(gb) || !Number.isFinite(gb)) {
		return json<ActionData>({ formError: "无效的容量" }, { status: 400 });
	}
	const snappedGb = toStepGb(gb);
	if (
		snappedGb < attachmentStorageLimits.MIN_TOTAL_STORAGE_LIMIT_BYTES / (1024 * 1024 * 1024) ||
		snappedGb > attachmentStorageLimits.MAX_TOTAL_STORAGE_LIMIT_BYTES / (1024 * 1024 * 1024)
	) {
		return json<ActionData>({ formError: "容量需在 1GB 到 100GB 之间" }, { status: 400 });
	}
	const bytes = normalizeTotalStorageLimitBytes(snappedGb * 1024 * 1024 * 1024);

	const now = Date.now();
	const db = getDBFromContext(context);
	const ip = getClientIp(request);
	const userAgent = request.headers.get("User-Agent");
	try {
		await execute(
			db,
			"INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
			[attachmentStorageLimits.TOTAL_STORAGE_LIMIT_SETTING_KEY, String(bytes), now],
		);
		try {
			await execute(
				db,
				"INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					me.id,
					"total_storage_limit_set",
					ip,
					userAgent,
					JSON.stringify({ limitBytes: bytes, limitGb: snappedGb }),
					now,
				],
			);
		} catch {
		}
		return redirect("/admin/storage");
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("no such table")) {
			return json<ActionData>({ formError: "数据库未初始化：缺少必要的数据表" }, { status: 500 });
		}
		if (message.includes("no such column")) {
			return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
		}
		return json<ActionData>({ formError: "保存失败，请稍后重试" }, { status: 500 });
	}
}

export default function AdminStoragePage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const limitGb = useMemo(() => toStepGb(data.usage.limitBytes / (1024 * 1024 * 1024)), [data.usage.limitBytes]);
	const usedTotalBytes = data.usage.usedBytes + data.usage.reservedBytes;
	const remainingBytes = Math.max(0, data.usage.limitBytes - usedTotalBytes);
	const usedRatio = data.usage.limitBytes > 0 ? usedTotalBytes / data.usage.limitBytes : 0;
	const nearFull = usedRatio >= 0.9;

	const [nextLimitGb, setNextLimitGb] = useState(() => limitGb);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [verifyPassword, setVerifyPassword] = useState("");
	const [dialogSubmitting, setDialogSubmitting] = useState(false);

	useEffect(() => {
		setNextLimitGb(limitGb);
	}, [limitGb]);

	useEffect(() => {
		if (!dialogSubmitting) return;
		if (navigation.state !== "idle") return;
		if (actionData?.formError) {
			setDialogSubmitting(false);
			return;
		}
		setDialogOpen(false);
		setVerifyPassword("");
		setDialogSubmitting(false);
	}, [actionData?.formError, dialogSubmitting, navigation.state]);

	const nextBytes = normalizeTotalStorageLimitBytes(toStepGb(nextLimitGb) * 1024 * 1024 * 1024);
	const nextText = formatTotalStorageLimit(nextBytes);
	const changed = nextBytes !== data.usage.limitBytes;

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<header className="flex items-center justify-between">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">存储容量管理</h1>
					<div className="flex items-center gap-2">
						<Link
							to="/admin/users"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							用户管理
						</Link>
						<Link
							to="/admin/attachments"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							附件管理
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

				<div className="rounded-xl bg-white p-5 shadow dark:bg-gray-800">
					<div className="flex flex-col gap-3">
						<div className="flex flex-wrap items-center gap-3 text-sm">
							<span className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 dark:bg-gray-900/40 dark:text-gray-200">
								当前上限：{formatTotalStorageLimit(data.usage.limitBytes)}
							</span>
							<span className="text-gray-700 dark:text-gray-200">
								已用：{formatSize(data.usage.usedBytes)}
							</span>
							<span className="text-gray-700 dark:text-gray-200">
								预留：{formatSize(data.usage.reservedBytes)}
							</span>
							<span className="text-gray-700 dark:text-gray-200">
								剩余：{formatSize(remainingBytes)}
							</span>
							{data.usage.paused ? (
								<span className="rounded bg-red-100 px-2 py-1 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-200">
									已暂停上传
								</span>
							) : null}
						</div>

						<div className="h-3 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
							<div
								className={nearFull ? "h-3 bg-red-600" : "h-3 bg-blue-600"}
								style={{ width: `${Math.min(100, Math.max(0, Math.round(usedRatio * 100)))}%` }}
							/>
						</div>

						{nearFull ? (
							<div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
								剩余容量不足 10%，建议尽快扩容或清理附件。
							</div>
						) : null}
					</div>
				</div>

				<div className="rounded-xl bg-white p-5 shadow dark:bg-gray-800">
					<div className="flex flex-col gap-4">
						<div>
							<div className="text-sm font-medium text-gray-900 dark:text-gray-100">调整全站附件总容量</div>
							<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
								范围 1GB–100GB，步长 0.5GB
							</div>
						</div>

						<div className="grid gap-4 sm:grid-cols-2">
							<div className="flex flex-col gap-2">
								<label className="text-sm font-medium text-gray-700 dark:text-gray-200">容量（GB）</label>
								<input
									type="number"
									min={1}
									max={100}
									step={0.5}
									value={nextLimitGb}
									onChange={(e) => setNextLimitGb(Number(e.target.value))}
									className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
								/>
								<input
									type="range"
									min={1}
									max={100}
									step={0.5}
									value={nextLimitGb}
									onChange={(e) => setNextLimitGb(Number(e.target.value))}
									className="w-full"
								/>
							</div>
							<div className="flex flex-col justify-between gap-3">
								<div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-100">
									<div className="text-xs text-gray-500 dark:text-gray-400">将设置为</div>
									<div className="mt-1 text-lg font-semibold">{nextText}</div>
									{!changed ? (
										<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">与当前配置一致</div>
									) : null}
								</div>
								<button
									type="button"
									onClick={() => {
										if (!changed) return;
										setDialogOpen(true);
										setVerifyPassword("");
									}}
									disabled={!changed}
									className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
								>
									保存设置
								</button>
							</div>
						</div>
					</div>
				</div>

				{dialogOpen ? (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
						<div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-lg dark:bg-gray-900">
							<div className="flex items-start justify-between gap-4">
								<div>
									<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">确认修改存储容量</h2>
									<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
										当前：{formatTotalStorageLimit(data.usage.limitBytes)}，将修改为：{nextText}
									</p>
								</div>
								<button
									type="button"
									onClick={() => {
										if (dialogSubmitting) return;
										setDialogOpen(false);
									}}
									disabled={dialogSubmitting}
									className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
								>
									关闭
								</button>
							</div>

							<div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
								该操作会影响全站附件上传策略。
							</div>

							<Form
								method="post"
								onSubmit={(e) => {
									if (!verifyPassword.trim()) {
										e.preventDefault();
										return;
									}
									setDialogSubmitting(true);
								}}
								className="mt-4 flex flex-col gap-4"
							>
								<input type="hidden" name="intent" value="setTotalStorageLimit" />
								<input type="hidden" name="limitGb" value={String(toStepGb(nextLimitGb))} />
								<div className="flex flex-col gap-2">
									<label className="text-sm font-medium text-gray-800 dark:text-gray-200">二次验证密码</label>
									<input
										type="password"
										name="password"
										value={verifyPassword}
										onChange={(e) => setVerifyPassword(e.target.value)}
										placeholder="请输入你的账号密码"
										className="w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
									/>
								</div>
								<div className="flex items-center justify-end gap-2">
									<button
										type="button"
										onClick={() => {
											if (dialogSubmitting) return;
											setDialogOpen(false);
										}}
										disabled={dialogSubmitting}
										className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
									>
										取消
									</button>
									<button
										type="submit"
										disabled={dialogSubmitting && navigation.state !== "idle"}
										className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
									>
										{dialogSubmitting && navigation.state !== "idle" ? "处理中..." : "确认执行"}
									</button>
								</div>
							</Form>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
