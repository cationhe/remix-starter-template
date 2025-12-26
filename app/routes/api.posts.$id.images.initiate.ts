import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { assertNotBanned, requireUser } from "~/lib/auth.server";
import { getDBFromContext, queryOne } from "~/lib/d1.server";
import { createPostImageUploadRecord, postImageLimits, validatePostImageMeta } from "~/lib/post-images.server";

type ActionData =
	| {
			ok: true;
			uploadRecordId: number;
			mode: "single" | "multipart";
			uploadId: string;
			partSizeBytes: number | null;
			limits: { maxImageSizeBytes: number; dailyUserImageUploadLimitBytes: number };
	  }
	| { ok: false; error: string };

export async function action({ request, context, params }: ActionFunctionArgs) {
	const user = await requireUser(request, context);
	assertNotBanned(user);

	const rawId = params.id;
	const postId = rawId ? Number(rawId) : NaN;
	if (!rawId || Number.isNaN(postId)) {
		return json<ActionData>({ ok: false, error: "无效的帖子ID" }, { status: 400 });
	}

	const db = getDBFromContext(context);
	const post = await queryOne<{ authorId: number }>(
		db,
		"SELECT author_id as authorId FROM posts WHERE id = ? AND deleted_at IS NULL",
		[postId],
	);
	if (!post) {
		return json<ActionData>({ ok: false, error: "帖子不存在" }, { status: 404 });
	}
	if (post.authorId !== user.id) {
		return json<ActionData>({ ok: false, error: "只有作者可以上传插图" }, { status: 403 });
	}

	let body: any = null;
	try {
		body = await request.json();
	} catch {
		return json<ActionData>({ ok: false, error: "请求格式错误" }, { status: 400 });
	}
	const filename = String(body?.filename || "");
	const mimeType = String(body?.mimeType || "");
	const sizeBytes = Number(body?.sizeBytes || 0);
	const metaError = validatePostImageMeta({ filename, mimeType, sizeBytes });
	if (metaError) {
		return json<ActionData>({ ok: false, error: metaError }, { status: 400 });
	}

	try {
		const { record, mode, partSizeBytes } = await createPostImageUploadRecord({
			context,
			request,
			user,
			postId,
			filename,
			mimeType,
			sizeBytes,
		});
		return json<ActionData>({
			ok: true,
			uploadRecordId: record.id,
			mode,
			uploadId: record.uploadId,
			partSizeBytes,
			limits: {
				maxImageSizeBytes: postImageLimits.MAX_IMAGE_SIZE_BYTES,
				dailyUserImageUploadLimitBytes: postImageLimits.DAILY_USER_IMAGE_UPLOAD_LIMIT_BYTES,
			},
		});
	} catch (error) {
		if (error instanceof Response) {
			return json<ActionData>({ ok: false, error: await error.text() }, { status: error.status });
		}
		return json<ActionData>({ ok: false, error: "创建上传任务失败" }, { status: 500 });
	}
}

