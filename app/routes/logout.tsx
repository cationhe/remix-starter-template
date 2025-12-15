import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { redirect } from "@remix-run/cloudflare";
import { destroySession, getSession } from "~/lib/session.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
	const session = await getSession(request, context);
	return redirect("/", {
		headers: {
			"Set-Cookie": await destroySession(session, context),
		},
	});
}

export default function Logout() {
	return null;
}

