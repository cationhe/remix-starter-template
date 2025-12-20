import { createCookieSessionStorage } from "@remix-run/cloudflare";
import type { AppLoadContext, Session } from "@remix-run/cloudflare";

function getEnv(context: AppLoadContext): Env {
	return (context as any).cloudflare.env as Env;
}

function isSecureRequest(request: Request) {
	return new URL(request.url).protocol === "https:";
}

function getSessionStorage(context: AppLoadContext, secure: boolean) {
	const env = getEnv(context);
	const secret = env.SESSION_SECRET || "dev-only-session-secret-change-me";
	return createCookieSessionStorage({
		cookie: {
			name: "__forum_session",
			secrets: [secret],
			secure,
			sameSite: "lax",
			path: "/",
			httpOnly: true,
		},
	});
}

export async function getSession(request: Request, context: AppLoadContext) {
	const storage = getSessionStorage(context, isSecureRequest(request));
	const cookie = request.headers.get("Cookie");
	return storage.getSession(cookie);
}

export async function commitSession(session: Session, request: Request, context: AppLoadContext) {
	const storage = getSessionStorage(context, isSecureRequest(request));
	return storage.commitSession(session);
}

export async function destroySession(session: Session, request: Request, context: AppLoadContext) {
	const storage = getSessionStorage(context, isSecureRequest(request));
	return storage.destroySession(session);
}
