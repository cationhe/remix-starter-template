import { createCookieSessionStorage } from "@remix-run/cloudflare";
import type { AppLoadContext, Session } from "@remix-run/cloudflare";

function getEnv(context: AppLoadContext): Env {
	return (context as any).cloudflare.env as Env;
}

function getSessionStorage(context: AppLoadContext) {
	const env = getEnv(context);
	return createCookieSessionStorage({
		cookie: {
			name: "__forum_session",
			secrets: [env.SESSION_SECRET],
			secure: true,
			sameSite: "lax",
			path: "/",
			httpOnly: true,
		},
	});
}

export async function getSession(request: Request, context: AppLoadContext) {
	const storage = getSessionStorage(context);
	const cookie = request.headers.get("Cookie");
	return storage.getSession(cookie);
}

export async function commitSession(session: Session, context: AppLoadContext) {
	const storage = getSessionStorage(context);
	return storage.commitSession(session);
}

export async function destroySession(session: Session, context: AppLoadContext) {
	const storage = getSessionStorage(context);
	return storage.destroySession(session);
}

