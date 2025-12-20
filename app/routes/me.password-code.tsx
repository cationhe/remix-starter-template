import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { requireUser, sendPasswordChangeCode, verifyPasswordChangeCode } from "~/lib/auth.server";

type ActionData =
	| { ok: true; intent: "send" }
	| { ok: true; intent: "verify" }
	| { ok: false; message: string };

export async function loader({}: LoaderFunctionArgs) {
	return json({});
}

export async function action({ request, context }: ActionFunctionArgs) {
	const user = await requireUser(request, context);
	const formData = await request.formData();
	const intent = String(formData.get("intent") || "").trim();

	try {
		if (intent === "send") {
			await sendPasswordChangeCode({ request, context, user });
			return json<ActionData>({ ok: true, intent: "send" });
		}
		if (intent === "verify") {
			const code = String(formData.get("code") || "").trim();
			if (!/^\d{6}$/.test(code)) {
				return json<ActionData>({ ok: false, message: "请输入 6 位数字验证码" }, { status: 400 });
			}
			await verifyPasswordChangeCode({ request, context, user, code });
			return json<ActionData>({ ok: true, intent: "verify" });
		}
		return json<ActionData>({ ok: false, message: "无效操作" }, { status: 400 });
	} catch (error) {
		if (error instanceof Response) {
			const text = await error.text();
			return json<ActionData>({ ok: false, message: text || "操作失败" }, { status: error.status });
		}
		const message = error instanceof Error ? error.message : "";
		if (message === "EMAIL_NOT_CONFIGURED") {
			return json<ActionData>({ ok: false, message: "邮件服务未配置" }, { status: 500 });
		}
		if (message === "EMAIL_SEND_FAILED") {
			return json<ActionData>({ ok: false, message: "邮件发送失败，请重试" }, { status: 500 });
		}
		if (message === "REDIS_NOT_CONFIGURED") {
			return json<ActionData>({ ok: false, message: "验证码服务未配置" }, { status: 500 });
		}
		return json<ActionData>({ ok: false, message: "操作失败，请稍后重试" }, { status: 500 });
	}
}
