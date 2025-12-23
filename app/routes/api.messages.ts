import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { deleteMessagesForUser } from "~/lib/messages.server";

type ActionData =
	| { ok: true; deletedCount: number }
	| { ok: false; error: string };

function normalizeIds(input: unknown): number[] {
	if (Array.isArray(input)) {
		return input.map((v) => Number(v));
	}
	return [];
}

export async function action({ request, context }: ActionFunctionArgs) {
	if (request.method.toUpperCase() !== "DELETE") {
		return json<ActionData>({ ok: false, error: "不支持的请求方法" }, { status: 405 });
	}

	const me = await requireUser(request, context);
	assertNotBanned(me);

	let ids: number[] = [];
	const contentType = request.headers.get("Content-Type") || "";
	if (contentType.includes("application/json")) {
		try {
			const payload = (await request.json()) as any;
			ids = normalizeIds(payload?.ids ?? payload?.messageIds);
		} catch {
			ids = [];
		}
	} else {
		try {
			const formData = await request.formData();
			ids = formData.getAll("id").map((v) => Number(v));
		} catch {
			ids = [];
		}
	}

	const result = await deleteMessagesForUser(context, { userId: me.id, messageIds: ids });
	if (!result.ok) {
		const status = result.error.includes("无权") ? 403 : 400;
		return json<ActionData>({ ok: false, error: result.error }, { status });
	}
	return json<ActionData>(
		{ ok: true, deletedCount: result.deletedCount },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

