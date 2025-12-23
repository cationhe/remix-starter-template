import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { countUnreadMessages } from "~/lib/messages.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
	const me = await requireUser(request, context);
	assertNotBanned(me);
	const unreadCount = await countUnreadMessages(context, me.id);
	return json(
		{ unreadCount },
		{
			headers: {
				"Cache-Control": "no-store",
			},
		},
	);
}

