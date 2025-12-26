import { test, expect } from "@playwright/test";

test("附件上传：选择文件后显示动态大小与超额数量提示", async ({ page }) => {
	const email = `e2e_attach_ui_${Date.now()}@example.com`;
	const password = "User1234";
	const title = `attach_ui_post_${Date.now()}`;

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("昵称").fill("e2e_attach_ui");
	await page.getByLabel("密码", { exact: true }).fill(password);
	await page.getByLabel("确认密码").fill(password);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.locator('input[name="title"]').fill(title);
	await page.locator('textarea[name="content"]').fill("attach ui");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.getByRole("link", { name: title }).click();
	await expect(page).toHaveURL(/\/posts\//);

	await expect(page.getByRole("button", { name: /上传\s*附件/ })).toBeEnabled();
	await expect(page.getByRole("button", { name: "开始上传" })).toBeDisabled();
	await expect(page.getByText(/已选\s+0\s+B\s+\/?\s*剩余/)).toBeVisible();

	await page.setInputFiles('input[type="file"]', [
		{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a".repeat(1024)) },
		{ name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("b".repeat(2048)) },
		{ name: "c.txt", mimeType: "text/plain", buffer: Buffer.from("c".repeat(1024)) },
		{ name: "d.txt", mimeType: "text/plain", buffer: Buffer.from("d".repeat(1024)) },
	]);

	await expect(page.getByText(/已选择\s+4\s+个，仅上传前\s+3\s+个/)).toBeVisible();
	await expect(page.getByText("a.txt")).toBeVisible();
	await expect(page.getByText("b.txt")).toBeVisible();
	await expect(page.getByText("c.txt")).toBeVisible();
	await expect(page.getByRole("button", { name: "开始上传" })).toBeEnabled();
});

test("topadmin 附件上传：数量不限时不显示超额数量提示", async ({ page }) => {
	const email = "e2e_topadmin@example.com";
	const password = "Topadmin123";
	const title = `attach_ui_topadmin_post_${Date.now()}`;

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("昵称").fill("topadmin");
	await page.getByLabel("密码", { exact: true }).fill(password);
	await page.getByLabel("确认密码").fill(password);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.locator('input[name="title"]').fill(title);
	await page.locator('textarea[name="content"]').fill("attach ui topadmin");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.getByRole("link", { name: title }).click();
	await expect(page).toHaveURL(/\/posts\//);

	await expect(page.getByRole("button", { name: /上传\s*附件/ })).toBeEnabled();
	await expect(page.getByText(/剩余可上传：\s*不限\s*个/)).toBeVisible();

	await page.setInputFiles('input[type="file"]', [
		{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a".repeat(1024)) },
		{ name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("b".repeat(2048)) },
		{ name: "c.txt", mimeType: "text/plain", buffer: Buffer.from("c".repeat(1024)) },
		{ name: "d.txt", mimeType: "text/plain", buffer: Buffer.from("d".repeat(1024)) },
	]);

	await expect(page.getByText(/已选择\s+4\s+个，仅上传前\s+3\s+个/)).toHaveCount(0);
	await expect(page.getByText("a.txt")).toBeVisible();
	await expect(page.getByText("b.txt")).toBeVisible();
	await expect(page.getByText("c.txt")).toBeVisible();
	await expect(page.getByText("d.txt")).toBeVisible();
	await expect(page.getByRole("button", { name: "开始上传" })).toBeEnabled();
});
