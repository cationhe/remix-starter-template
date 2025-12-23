import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import {
	Form,
	Link,
	useActionData,
	useFetcher,
	useLoaderData,
	useNavigation,
	useRevalidator,
} from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import {
	countMessagesForUser,
	countUnreadMessages,
	listMessagesForUser,
	listRecipientsForUser,
	markMessageAsRead,
	sendMessage,
} from "~/lib/messages.server";

type LoaderData = {
	me: Awaited<ReturnType<typeof requireUser>>;
	messages: Awaited<ReturnType<typeof listMessagesForUser>>;
	page: number;
	pageSize: number;
	totalPages: number;
	totalCount: number;
	unreadCount: number;
	recipients: Awaited<ReturnType<typeof listRecipientsForUser>>;
};

type ActionData = {
	formError?: string;
};

function parsePositiveInt(value: string | null, fallback: number) {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
}

function parseId(value: FormDataEntryValue | null) {
	const raw = typeof value === "string" ? value : "";
	const id = Number(raw);
	if (!raw || Number.isNaN(id) || !Number.isFinite(id) || id <= 0) {
		return null;
	}
	return Math.floor(id);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);

	const url = new URL(request.url);
	const pageSize = 20;
	const requestedPage = parsePositiveInt(url.searchParams.get("page"), 1);

	const totalCount = await countMessagesForUser(context, me.id);
	const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
	const page = Math.min(requestedPage, totalPages);

	const [messages, unreadCount, recipients] = await Promise.all([
		listMessagesForUser(context, me.id, page, pageSize),
		countUnreadMessages(context, me.id),
		listRecipientsForUser(context, me),
	]);

	return json<LoaderData>(
		{
			me,
			messages,
			page,
			pageSize,
			totalPages,
			totalCount,
			unreadCount,
			recipients,
		},
		{
			headers: {
				"Cache-Control": "no-store",
			},
		},
	);
}

export async function action({ request, context }: ActionFunctionArgs) {
	if (request.method.toUpperCase() !== "POST") {
		return json<ActionData>({ formError: "不支持的请求方法" }, { status: 405 });
	}

	const me = await requireUser(request, context);
	assertNotBanned(me);

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return json<ActionData>({ formError: "请求格式错误" }, { status: 400 });
	}
	const intent = String(formData.get("intent") || "");

	if (intent === "send") {
		const recipientId = parseId(formData.get("recipientId"));
		if (!recipientId) {
			return json<ActionData>({ formError: "请选择收件人" }, { status: 400 });
		}
		const content = typeof formData.get("content") === "string" ? String(formData.get("content")) : "";
		const result = await sendMessage(context, { sender: me, recipientId, content });
		if (!result.ok) {
			return json<ActionData>({ formError: result.error }, { status: 403 });
		}
		return redirect("/messages");
	}

	if (intent === "markRead") {
		const messageId = parseId(formData.get("messageId"));
		if (!messageId) {
			return json<ActionData>({ formError: "无效的消息ID" }, { status: 400 });
		}
		await markMessageAsRead(context, { userId: me.id, messageId });
		return json({ ok: true });
	}

	return json<ActionData>({ formError: "未知操作" }, { status: 400 });
}

export default function MessagesPage() {
	const data = useLoaderData<typeof loader>();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const revalidator = useRevalidator();
	const isSubmitting = navigation.state === "submitting";
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [draft, setDraft] = useState("");
	const markFetcher = useFetcher<{ ok: boolean }>();
	const unreadFetcher = useFetcher<{ unreadCount: number }>();
	const handledMarkReadRef = useRef(false);

	useEffect(() => {
		const id = setInterval(() => {
			if (unreadFetcher.state !== "idle") return;
			unreadFetcher.load("/api/messages/unread");
		}, 10000);
		return () => clearInterval(id);
	}, [unreadFetcher]);

	useEffect(() => {
		if (markFetcher.state === "submitting") {
			handledMarkReadRef.current = false;
			return;
		}
		if (markFetcher.state !== "idle") return;
		if (!markFetcher.data?.ok) return;
		if (handledMarkReadRef.current) return;
		handledMarkReadRef.current = true;
		unreadFetcher.load("/api/messages/unread");
		window.dispatchEvent(new Event("messages-unread-refresh"));
		revalidator.revalidate();
	}, [markFetcher.state, markFetcher.data, unreadFetcher, revalidator]);

	const unreadCount =
		unreadFetcher.data && typeof unreadFetcher.data.unreadCount === "number"
			? unreadFetcher.data.unreadCount
			: data.unreadCount;

	const recipientOptions = useMemo(() => {
		return data.recipients.map((u) => ({
			id: u.id,
			label: `${u.displayName}（${u.role}）`,
		}));
	}, [data.recipients]);

	const canSend = Boolean(selectedId && draft.trim().length > 0) && !isSubmitting;

	const canPrev = data.page > 1;
	const canNext = data.page < data.totalPages;

	return (
		<div className="min-h-screen bg-gray-50 px-4 py-8 dark:bg-gray-900">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex items-start justify-between gap-4">
					<div>
						<div className="flex items-center gap-2">
							<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">消息中心</h1>
							{unreadCount > 0 ? (
								<span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-200">
									{unreadCount} 条未读
								</span>
							) : null}
						</div>
						<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
							{data.me.displayName}（{data.me.role}）
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Link
							to="/posts"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							返回论坛
						</Link>
						<Link
							to="/me"
							className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
						>
							个人中心
						</Link>
					</div>
				</header>

				{actionData?.formError ? (
					<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
						{actionData.formError}
					</div>
				) : null}

				<section className="rounded-xl bg-white p-6 shadow dark:bg-gray-800">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">撰写消息</h2>
					<Form method="post" className="mt-4 space-y-3">
						<input type="hidden" name="intent" value="send" />
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							<div className="sm:col-span-1">
								<label className="block text-sm font-medium text-gray-900 dark:text-gray-100">收件人</label>
								<select
									name="recipientId"
									value={selectedId ?? ""}
									onChange={(e) => {
										const v = e.target.value;
										setSelectedId(v ? Number(v) : null);
									}}
									className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
									disabled={isSubmitting}
								>
									<option value="">请选择</option>
									{recipientOptions.map((o) => (
										<option key={o.id} value={o.id}>
											{o.label}
										</option>
									))}
								</select>
							</div>
							<div className="sm:col-span-2">
								<label className="block text-sm font-medium text-gray-900 dark:text-gray-100">内容</label>
								<textarea
									name="content"
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
									rows={4}
									maxLength={2000}
									className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
									disabled={isSubmitting}
									placeholder="请输入消息内容（最多 2000 字）"
								/>
							</div>
						</div>
						<div className="flex items-center justify-between gap-3">
							<span className="text-xs text-gray-500 dark:text-gray-400">{draft.trim().length}/2000</span>
							<button
								type="submit"
								disabled={!canSend}
								className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-70"
							>
								{isSubmitting ? "发送中..." : "发送"}
							</button>
						</div>
					</Form>
				</section>

				<section className="rounded-xl bg-white shadow dark:bg-gray-800">
					<div className="flex items-center justify-between px-6 py-4">
						<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">消息列表</h2>
						<div className="text-xs text-gray-500 dark:text-gray-400">
							共 {data.totalCount} 条，第 {data.page}/{data.totalPages} 页
						</div>
					</div>
					{data.messages.length === 0 ? (
						<p className="px-6 pb-6 text-sm text-gray-600 dark:text-gray-300">暂无消息</p>
					) : (
						<ul className="divide-y divide-gray-200 dark:divide-gray-700">
							{data.messages.map((m) => {
								const isRecipient = m.recipientId === data.me.id;
								const unread = isRecipient && !m.readAt;
								return (
									<li key={m.id} className={unread ? "bg-amber-50/60 px-6 py-4 dark:bg-amber-900/10" : "px-6 py-4"}>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0 flex-1">
												<div className="flex flex-wrap items-center gap-2">
													<span className="text-sm font-medium text-gray-900 dark:text-gray-100">
														{m.senderName} → {m.recipientName}
													</span>
													{unread ? (
														<span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-200">
															未读
														</span>
													) : null}
												</div>
												<p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-200">
													{m.content}
												</p>
												<div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
													{new Date(m.createdAt).toLocaleString()}
													{isRecipient ? (
														m.readAt ? (
															<span> · 已读 {new Date(m.readAt).toLocaleString()}</span>
														) : (
															<span> · 未读</span>
														)
													) : m.readAt ? (
														<span> · 对方已读</span>
													) : (
														<span> · 对方未读</span>
													)}
												</div>
											</div>
											{unread ? (
												<markFetcher.Form method="post">
													<input type="hidden" name="intent" value="markRead" />
													<input type="hidden" name="messageId" value={m.id} />
													<button
														type="submit"
														className="shrink-0 rounded border border-gray-300 px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-70 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
														disabled={markFetcher.state === "submitting"}
													>
														标记已读
													</button>
												</markFetcher.Form>
										) : null}
									</div>
								</li>
							);
						})}
						</ul>
					)}
					<div className="flex items-center justify-between px-6 py-4 text-sm">
						<div className="text-gray-600 dark:text-gray-300">第 {data.page} / {data.totalPages} 页</div>
						<div className="flex items-center gap-3">
							{canPrev ? (
								<Link
									to={`/messages?page=${data.page - 1}`}
									className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
								>
									上一页
								</Link>
							) : (
								<span className="rounded border border-gray-200 px-3 py-1 text-gray-400 dark:border-gray-700 dark:text-gray-500">上一页</span>
							)}
							{canNext ? (
								<Link
									to={`/messages?page=${data.page + 1}`}
									className="rounded border border-gray-300 px-3 py-1 text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
								>
									下一页
								</Link>
							) : (
								<span className="rounded border border-gray-200 px-3 py-1 text-gray-400 dark:border-gray-700 dark:text-gray-500">下一页</span>
							)}
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}
