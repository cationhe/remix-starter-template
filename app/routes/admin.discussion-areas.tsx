import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import { assertNotBanned, getClientIp, isSuperadmin, requireUser, verifyLogin } from "~/lib/auth.server";
import { execute, getDBFromContext, queryAll, queryOne } from "~/lib/d1.server";

type DiscussionAreaRow = {
	id: number;
	name: string;
	sortOrder: number;
	isHidden: number;
	createdAt: number;
	updatedAt: number;
	postCount: number;
};

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	areas: DiscussionAreaRow[];
	canReorder: boolean;
};

type ActionData = {
	formError?: string;
};

function parseId(value: FormDataEntryValue | null) {
	const raw = String(value || "").trim();
	const num = Number(raw);
	if (!raw || Number.isNaN(num) || !Number.isFinite(num)) return null;
	const id = Math.floor(num);
	if (id <= 0) return null;
	return id;
}

function normalizeName(value: FormDataEntryValue | null) {
	const name = String(value || "").trim();
	if (!name) return null;
	if (name.length > 30) return null;
	return name;
}

function normalizeHidden(value: FormDataEntryValue | null) {
	const raw = String(value || "").trim();
	if (raw === "1" || raw.toLowerCase() === "true") return 1;
	if (raw === "0" || raw.toLowerCase() === "false") return 0;
	return null;
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
			[
				args.userId,
				args.eventType,
				args.ip,
				args.userAgent,
				JSON.stringify(args.metadata),
				Date.now(),
			],
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
	const canReorder = isSuperadmin(me);
	const db = getDBFromContext(context);
	const areas = await queryAll<DiscussionAreaRow>(
		db,
		"SELECT a.id as id, a.name as name, a.sort_order as sortOrder, a.is_hidden as isHidden, a.created_at as createdAt, a.updated_at as updatedAt, (SELECT COUNT(1) FROM posts p WHERE p.area_id = a.id) as postCount FROM discussion_areas a ORDER BY a.sort_order ASC, a.id ASC",
	);
	return json<LoaderData>({ me, areas, canReorder });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	if (me.role !== "superadmin" && me.role !== "topadmin") {
		return json<ActionData>({ formError: "只有超级管理员或站点管理员可访问" }, { status: 403 });
	}

	const formData = await request.formData();
	const intent = String(formData.get("intent") || "");
	const db = getDBFromContext(context);
	const ip = getClientIp(request);
	const userAgent = request.headers.get("User-Agent");

	if (intent === "createArea") {
		const name = normalizeName(formData.get("name"));
		if (!name) {
			return json<ActionData>({ formError: "讨论区名称不能为空且长度需不超过 30" }, { status: 400 });
		}
		const now = Date.now();
		try {
			const maxRow = await queryOne<{ maxSort: number | null }>(
				db,
				"SELECT MAX(sort_order) as maxSort FROM discussion_areas",
			);
			const nextSort = (maxRow?.maxSort ?? 0) + 1;
			const insertRes = await execute(
				db,
				"INSERT INTO discussion_areas (name, sort_order, is_hidden, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
				[name, nextSort, now, now],
			);
			const createdAreaId = (() => {
				const v = (insertRes as any)?.meta?.last_row_id;
				return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
			})();
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_created",
				ip,
				userAgent,
				metadata: { areaId: createdAreaId, name, sortOrder: nextSort },
			});
			return redirect("/admin/discussion-areas");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_create_failed",
				ip,
				userAgent,
				metadata: { name, message },
			});
			if (message.includes("UNIQUE") || message.includes("unique")) {
				return json<ActionData>({ formError: "讨论区名称已存在" }, { status: 400 });
			}
			if (message.includes("no such table")) {
				return json<ActionData>({ formError: "数据库未初始化：缺少必要的数据表" }, { status: 500 });
			}
			if (message.includes("no such column")) {
				return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
			}
			return json<ActionData>({ formError: "创建失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "updateArea") {
		const areaId = parseId(formData.get("areaId"));
		if (!areaId) {
			return json<ActionData>({ formError: "无效的讨论区ID" }, { status: 400 });
		}
		const name = normalizeName(formData.get("name"));
		if (!name) {
			return json<ActionData>({ formError: "讨论区名称不能为空且长度需不超过 30" }, { status: 400 });
		}
		try {
			const now = Date.now();
			await execute(db, "UPDATE discussion_areas SET name = ?, updated_at = ? WHERE id = ?", [name, now, areaId]);
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_updated",
				ip,
				userAgent,
				metadata: { areaId, name },
			});
			return redirect("/admin/discussion-areas");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_update_failed",
				ip,
				userAgent,
				metadata: { areaId, name, message },
			});
			if (message.includes("UNIQUE") || message.includes("unique")) {
				return json<ActionData>({ formError: "讨论区名称已存在" }, { status: 400 });
			}
			if (message.includes("no such table")) {
				return json<ActionData>({ formError: "数据库未初始化：缺少必要的数据表" }, { status: 500 });
			}
			if (message.includes("no such column")) {
				return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
			}
			return json<ActionData>({ formError: "保存失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "setHidden") {
		const areaId = parseId(formData.get("areaId"));
		if (!areaId) {
			return json<ActionData>({ formError: "无效的讨论区ID" }, { status: 400 });
		}
		const hidden = normalizeHidden(formData.get("hidden"));
		if (hidden === null) {
			return json<ActionData>({ formError: "无效的可见性" }, { status: 400 });
		}
		const password = String(formData.get("password") || "").trim();
		if (!password) {
			return json<ActionData>({ formError: "需要二次验证密码" }, { status: 400 });
		}
		const verified = await verifyLogin(context, me.email, password);
		if (!verified || verified.id !== me.id) {
			return json<ActionData>({ formError: "二次验证失败" }, { status: 403 });
		}
		try {
			const now = Date.now();
			await execute(db, "UPDATE discussion_areas SET is_hidden = ?, updated_at = ? WHERE id = ?", [hidden, now, areaId]);
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_visibility_updated",
				ip,
				userAgent,
				metadata: { areaId, hidden },
			});
			return redirect("/admin/discussion-areas");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_visibility_update_failed",
				ip,
				userAgent,
				metadata: { areaId, hidden, message },
			});
			if (message.includes("no such table")) {
				return json<ActionData>({ formError: "数据库未初始化：缺少必要的数据表" }, { status: 500 });
			}
			if (message.includes("no such column")) {
				return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
			}
			return json<ActionData>({ formError: "保存失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "deleteArea") {
		const areaId = parseId(formData.get("areaId"));
		if (!areaId) {
			return json<ActionData>({ formError: "无效的讨论区ID" }, { status: 400 });
		}
		if (areaId === 1) {
			return json<ActionData>({ formError: "不能删除默认公告区" }, { status: 400 });
		}
		const password = String(formData.get("password") || "").trim();
		if (!password) {
			return json<ActionData>({ formError: "需要二次验证密码" }, { status: 400 });
		}
		const verified = await verifyLogin(context, me.email, password);
		if (!verified || verified.id !== me.id) {
			return json<ActionData>({ formError: "二次验证失败" }, { status: 403 });
		}
		try {
			const area = await queryOne<{ id: number; name: string }>(
				db,
				"SELECT id as id, name as name FROM discussion_areas WHERE id = ?",
				[areaId],
			);
			if (!area) {
				return json<ActionData>({ formError: "讨论区不存在" }, { status: 404 });
			}
			const moveRow = await queryOne<{ count: number | string }>(
				db,
				"SELECT COUNT(1) as count FROM posts WHERE area_id = ?",
				[areaId],
			);
			const moveCount = Number(moveRow?.count ?? 0) || 0;
			await execute(db, "UPDATE posts SET area_id = 1 WHERE area_id = ?", [areaId]);
			await execute(db, "DELETE FROM discussion_areas WHERE id = ?", [areaId]);
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_deleted",
				ip,
				userAgent,
				metadata: { areaId, name: area.name, movedPostCount: moveCount, movedToAreaId: 1 },
			});
			return redirect("/admin/discussion-areas");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_delete_failed",
				ip,
				userAgent,
				metadata: { areaId, message },
			});
			if (message.includes("no such table")) {
				return json<ActionData>({ formError: "数据库未初始化：缺少必要的数据表" }, { status: 500 });
			}
			if (message.includes("no such column")) {
				return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
			}
			return json<ActionData>({ formError: "删除失败，请稍后重试" }, { status: 500 });
		}
	}

	if (intent === "reorderAreas") {
		if (!isSuperadmin(me)) {
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_reorder_denied",
				ip,
				userAgent,
				metadata: { role: me.role },
			});
			return json<ActionData>({ formError: "只有超级管理员或站点管理员可调整讨论区顺序" }, { status: 403 });
		}
		const password = String(formData.get("password") || "").trim();
		if (!password) {
			return json<ActionData>({ formError: "需要二次验证密码" }, { status: 400 });
		}
		const verified = await verifyLogin(context, me.email, password);
		if (!verified || verified.id !== me.id) {
			return json<ActionData>({ formError: "二次验证失败" }, { status: 403 });
		}
		const orderRaw = String(formData.get("orderJson") || "").trim();
		let ids: number[] = [];
		try {
			const parsed = JSON.parse(orderRaw) as unknown;
			if (!Array.isArray(parsed)) {
				return json<ActionData>({ formError: "无效的排序数据" }, { status: 400 });
			}
			ids = parsed.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0).map((v) => Math.floor(v));
		} catch {
			return json<ActionData>({ formError: "无效的排序数据" }, { status: 400 });
		}
		const unique = Array.from(new Set(ids));
		if (unique.length !== ids.length) {
			return json<ActionData>({ formError: "排序数据包含重复项" }, { status: 400 });
		}
		const dbIds = await queryAll<{ id: number }>(db, "SELECT id as id FROM discussion_areas");
		const existing = new Set(dbIds.map((r) => r.id));
		if (unique.length !== existing.size) {
			return json<ActionData>({ formError: "排序数据数量不匹配" }, { status: 400 });
		}
		for (const id of unique) {
			if (!existing.has(id)) {
				return json<ActionData>({ formError: "排序数据包含不存在的讨论区" }, { status: 400 });
			}
		}
		try {
			const now = Date.now();
			for (let i = 0; i < unique.length; i++) {
				await execute(db, "UPDATE discussion_areas SET sort_order = ?, updated_at = ? WHERE id = ?", [i + 1, now, unique[i]]);
			}
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_reordered",
				ip,
				userAgent,
				metadata: { order: unique },
			});
			return redirect("/admin/discussion-areas");
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			await logEvent({
				context,
				userId: me.id,
				eventType: "discussion_area_reorder_failed",
				ip,
				userAgent,
				metadata: { message, order: unique },
			});
			if (message.includes("no such table")) {
				return json<ActionData>({ formError: "数据库未初始化：缺少必要的数据表" }, { status: 500 });
			}
			if (message.includes("no such column")) {
				return json<ActionData>({ formError: "数据库未升级：请先应用最新迁移" }, { status: 500 });
			}
			return json<ActionData>({ formError: "保存失败，请稍后重试" }, { status: 500 });
		}
	}

	return json<ActionData>({ formError: "未知操作" }, { status: 400 });
}

type DialogIntent = "deleteArea" | "setHidden" | "reorderAreas";

export default function AdminDiscussionAreasPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const canReorder = data.canReorder;
	const initialAreas = useMemo(() => data.areas, [data.areas]);
	const [areas, setAreas] = useState(() => initialAreas);
	const [draggingId, setDraggingId] = useState<number | null>(null);
	const [manualOrderById, setManualOrderById] = useState<Record<number, string>>({});
	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogIntent, setDialogIntent] = useState<DialogIntent>("reorderAreas");
	const [dialogAreaId, setDialogAreaId] = useState<number | null>(null);
	const [dialogHidden, setDialogHidden] = useState<0 | 1>(0);
	const [verifyPassword, setVerifyPassword] = useState("");
	const [dialogSubmitting, setDialogSubmitting] = useState(false);

	useEffect(() => {
		setAreas(initialAreas);
		setManualOrderById({});
	}, [initialAreas]);

	useEffect(() => {
		if (!dialogSubmitting) return;
		if (navigation.state !== "idle") return;
		if (actionData?.formError) {
			setDialogSubmitting(false);
			return;
		}
		setDialogOpen(false);
		setDialogAreaId(null);
		setVerifyPassword("");
		setDialogSubmitting(false);
	}, [actionData?.formError, dialogSubmitting, navigation.state]);

	function openDialog(next: { intent: DialogIntent; areaId?: number; hidden?: 0 | 1 }) {
		if (next.intent === "reorderAreas" && !canReorder) return;
		setDialogIntent(next.intent);
		setDialogAreaId(typeof next.areaId === "number" ? next.areaId : null);
		setDialogHidden(next.hidden ?? 0);
		setVerifyPassword("");
		setDialogOpen(true);
		setDialogSubmitting(false);
	}

	function moveArea(dragId: number, overId: number) {
		if (!canReorder) return;
		if (dragId === overId) return;
		setAreas((prev) => {
			const from = prev.findIndex((a) => a.id === dragId);
			const to = prev.findIndex((a) => a.id === overId);
			if (from === -1 || to === -1) return prev;
			const next = prev.slice();
			const [item] = next.splice(from, 1);
			next.splice(to, 0, item);
			return next;
		});
	}

	function applyManualOrder(areaId: number, raw: string, currentIndex: number) {
		if (!canReorder) return;
		const nextNum = Math.floor(Number(String(raw || "").trim()));
		if (!Number.isFinite(nextNum)) {
			setManualOrderById((prev) => {
				const next = { ...prev };
				delete next[areaId];
				return next;
			});
			return;
		}
		const toIndex = Math.max(0, Math.min(areas.length - 1, nextNum - 1));
		setAreas((prev) => {
			const from = prev.findIndex((a) => a.id === areaId);
			if (from === -1) return prev;
			const next = prev.slice();
			const [item] = next.splice(from, 1);
			next.splice(toIndex, 0, item);
			return next;
		});
		setManualOrderById((prev) => {
			const next = { ...prev };
			delete next[areaId];
			return next;
		});
	}

	const dialogArea = dialogAreaId ? areas.find((a) => a.id === dialogAreaId) ?? null : null;
	const orderJson = useMemo(() => JSON.stringify(areas.map((a) => a.id)), [areas]);
	const hasOrderChanged = useMemo(() => {
		const a = initialAreas.map((x) => x.id).join(",");
		const b = areas.map((x) => x.id).join(",");
		return a !== b;
	}, [areas, initialAreas]);
	const previewAreas = useMemo(() => areas.filter((a) => !a.isHidden), [areas]);

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<header className="flex items-center justify-between">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">讨论区管理</h1>
					<div className="flex items-center gap-2">
						<Link
							to="/admin/users"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							用户管理
						</Link>
						<Link
							to="/admin/storage"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							存储容量
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

				<div className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
					<Form method="post" className="flex flex-col gap-3 sm:flex-row sm:items-end">
						<input type="hidden" name="intent" value="createArea" />
						<div className="flex-1">
							<label className="block text-sm font-medium text-gray-700 dark:text-gray-200">新建讨论区</label>
							<input
								name="name"
								placeholder="例如：综合讨论"
								className="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
							/>
						</div>
						<button
							type="submit"
							className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 sm:mt-0"
						>
							创建
						</button>
					</Form>
				</div>

				<div className="overflow-hidden rounded-xl bg-white shadow dark:bg-gray-800">
					<div className="flex items-center justify-between px-4 py-3">
						<div className="text-sm font-medium text-gray-900 dark:text-gray-100">讨论区列表</div>
						<button
							type="button"
							disabled={!canReorder || !hasOrderChanged}
							onClick={() => openDialog({ intent: "reorderAreas" })}
							className={
								canReorder && hasOrderChanged
									? "rounded bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
									: "rounded bg-gray-200 px-3 py-1 text-sm font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-300"
							}
						>
							保存排序
						</button>
					</div>
					{!canReorder ? (
						<div className="px-4 pb-3 text-xs text-gray-500 dark:text-gray-400">只有超级管理员或站点管理员可调整讨论区顺序</div>
					) : null}
					<table className="w-full table-auto text-left text-sm">
						<thead className="bg-gray-100 text-xs text-gray-600 dark:bg-gray-900/30 dark:text-gray-300">
							<tr>
								<th className="px-4 py-3">顺序</th>
								<th className="px-4 py-3">名称</th>
								<th className="px-4 py-3">帖子数</th>
								<th className="px-4 py-3">可见性</th>
								<th className="px-4 py-3">操作</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-200 dark:divide-gray-700">
							{areas.map((a, index) => {
								const isDefault = a.id === 1;
								const hidden = Boolean(a.isHidden);
								const manualValue = manualOrderById[a.id];
								return (
									<tr
										key={a.id}
										draggable={canReorder}
										onDragStart={() => {
											if (!canReorder) return;
											setDraggingId(a.id);
										}}
										onDragEnd={() => setDraggingId(null)}
										onDragOver={(e) => {
											e.preventDefault();
											if (draggingId) moveArea(draggingId, a.id);
										}}
										className={
											hidden
												? "bg-gray-50 text-gray-900 dark:bg-gray-900/20 dark:text-gray-100"
												: "text-gray-900 dark:text-gray-100"
										}
									>
										<td className="px-4 py-3 text-gray-700 dark:text-gray-200">
											{canReorder ? (
												<input
													type="number"
													min={1}
													max={areas.length}
													value={typeof manualValue === "string" ? manualValue : String(index + 1)}
													onChange={(e) =>
														setManualOrderById((prev) => ({ ...prev, [a.id]: e.target.value }))
													}
													onBlur={(e) => applyManualOrder(a.id, e.target.value, index)}
													onKeyDown={(e) => {
														if (e.key !== "Enter") return;
														(e.currentTarget as HTMLInputElement).blur();
													}}
													className="w-16 rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
												/>
											) : (
												<span>{index + 1}</span>
											)}
										</td>
										<td className="px-4 py-3">
											<Form method="post" className="flex items-center gap-2">
												<input type="hidden" name="intent" value="updateArea" />
												<input type="hidden" name="areaId" value={a.id} />
												<input
													name="name"
													defaultValue={a.name}
													className="w-full min-w-[140px] rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
												/>
												<button
													type="submit"
													className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
												>
													保存
												</button>
											</Form>
										</td>
										<td className="px-4 py-3 text-gray-700 dark:text-gray-200">{a.postCount}</td>
										<td className="px-4 py-3">
											<span
												className={
													hidden
														? "rounded bg-gray-200 px-2 py-1 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-100"
														: "rounded bg-green-100 px-2 py-1 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-200"
												}
											>
												{hidden ? "隐藏" : "公开"}
											</span>
										</td>
										<td className="px-4 py-3">
											<div className="flex flex-wrap items-center gap-2">
												<button
													type="button"
													onClick={() =>
													openDialog({ intent: "setHidden", areaId: a.id, hidden: hidden ? 0 : 1 })
												}
												className={
													hidden
														? "rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700"
														: "rounded bg-gray-800 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
													}
												>
													{hidden ? "设为公开" : "设为隐藏"}
												</button>
												{!isDefault ? (
													<button
														type="button"
														onClick={() => openDialog({ intent: "deleteArea", areaId: a.id })}
													className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
													>
													删除
													</button>
												) : (
													<span className="text-xs text-gray-500 dark:text-gray-400">默认</span>
												)}
											</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

				<div className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
					<div className="flex items-center justify-between">
						<div className="text-sm font-medium text-gray-900 dark:text-gray-100">主页预览</div>
						<Link
							to="/posts"
							className="text-xs text-blue-600 hover:underline dark:text-blue-400"
						>
							打开前台
						</Link>
					</div>
					<p className="mt-2 text-xs text-gray-500 dark:text-gray-400">按普通用户可见的讨论区顺序展示</p>
					{previewAreas.length === 0 ? (
						<div className="mt-3 rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900/20 dark:text-gray-300">
							当前没有公开讨论区
						</div>
					) : (
						<div className="mt-3 flex flex-col gap-3">
							{previewAreas.map((area) => (
								<section key={area.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900/10">
									<div className="flex items-center justify-between px-4 py-3">
										<h3 className="text-sm font-semibold">
											<Link to={`/areas/${area.id}`} className="text-blue-700 hover:underline dark:text-blue-400">
												{area.name}
											</Link>
										</h3>
										<span className="text-xs text-gray-500 dark:text-gray-400">仅展示最新 5 帖</span>
									</div>
									<div className="px-4 pb-4 text-xs text-gray-600 dark:text-gray-300">当前帖子数：{area.postCount}</div>
								</section>
							))}
						</div>
					)}
				</div>

				{dialogOpen ? (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
						<div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-lg dark:bg-gray-900">
							<div className="flex items-start justify-between gap-4">
								<div>
									<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
										{dialogIntent === "deleteArea"
											? "删除讨论区"
											: dialogIntent === "setHidden"
												? "修改可见性"
												: "保存排序"}
									</h2>
									{dialogIntent !== "reorderAreas" && dialogArea ? (
										<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
											讨论区：{dialogArea.name}（ID {dialogArea.id}）
										</p>
									) : null}
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

							{dialogIntent === "deleteArea" ? (
								<div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
									删除后，该讨论区下的帖子会被移动到“站点公告区”。
								</div>
							) : dialogIntent === "setHidden" ? (
								<div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
									该操作会影响前台是否展示该讨论区。
								</div>
							) : (
								<div className="mt-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-900/50 dark:bg-blue-900/20 dark:text-blue-200">
									可拖拽或输入数字调整顺序，保存后前台展示顺序会更新。
								</div>
							)}

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
								<input type="hidden" name="intent" value={dialogIntent} />
								{dialogIntent !== "reorderAreas" ? (
									<input type="hidden" name="areaId" value={dialogAreaId ?? ""} />
								) : (
									<input type="hidden" name="orderJson" value={orderJson} />
								)}
								{dialogIntent === "setHidden" ? (
									<input type="hidden" name="hidden" value={String(dialogHidden)} />
								) : null}
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
										className={
											dialogIntent === "deleteArea"
												? "rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
												: dialogIntent === "setHidden"
													? "rounded bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700"
													: "rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
										}
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
