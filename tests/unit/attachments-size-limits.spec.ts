import { test, expect } from "@playwright/test";
import { validateAttachmentMeta } from "../../app/lib/attachments.server";

test("附件最小大小：9B 应被拒绝", () => {
	const err = validateAttachmentMeta({
		filename: "a.pdf",
		mimeType: "application/pdf",
		sizeBytes: 9,
	});
	expect(err).toBe("上传文件大小不能小于10字节");
});

test("附件最小大小：10B 应被接受", () => {
	const err = validateAttachmentMeta({
		filename: "a.pdf",
		mimeType: "application/pdf",
		sizeBytes: 10,
	});
	expect(err).toBeNull();
});

test("附件大文件：正常大小应通过校验", () => {
	const err = validateAttachmentMeta({
		filename: "b.pdf",
		mimeType: "application/pdf",
		sizeBytes: 1024 * 1024,
	});
	expect(err).toBeNull();
});
