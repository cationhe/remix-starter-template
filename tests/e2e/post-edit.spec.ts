import { test, expect } from "@playwright/test";

function randomFakeIp(prefix: string) {
	return `${prefix}.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
}

test("帖子编辑：作者可编辑并生成修改历史，其他用户不可编辑", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);
	await page.setExtraHTTPHeaders({
		"CF-Connecting-IP": randomFakeIp("10"),
		"X-Forwarded-For": randomFakeIp("10"),
	});

	const authorEmail = `e2e_post_edit_author_${Date.now()}@example.com`;
	const authorPassword = "User12345";
	const title = `edit_post_${Date.now()}`;
	const originalContent = "old_content";
	const updatedContent = `new_content_${Date.now()}`;

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(authorEmail);
	await page.getByLabel("昵称").fill("author");
	await page.getByLabel("密码", { exact: true }).fill(authorPassword);
	await page.getByLabel("确认密码").fill(authorPassword);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.locator('input[name="title"]').fill(title);
	await page.locator('textarea[name="content"]').fill(originalContent);
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.getByRole("link", { name: title }).click();
	await expect(page).toHaveURL(/\/posts\/(\d+)/);
	const match = page.url().match(/\/posts\/(\d+)/);
	expect(Boolean(match)).toBeTruthy();
	const postId = String(match?.[1] || "");
	expect(Number(postId) > 0).toBeTruthy();

	await expect(page.getByRole("link", { name: "编辑" })).toBeVisible();
	await page.goto(`/posts/${postId}/edit`, { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "编辑帖子" })).toBeVisible();

	await page.locator('textarea[name="content"]').fill(updatedContent);
	await page.locator('input[name="confirm"]').check();
	await page.getByRole("button", { name: "保存" }).click();
	await expect(page).toHaveURL(new RegExp(`/posts/${postId}$`));
	await expect(page.getByText(updatedContent)).toBeVisible();
	await expect(page.getByText(/最后修改：/)).toBeVisible();
	await expect(page.getByRole("heading", { name: /修改历史/ })).toBeVisible();
	await expect(page.getByText(/修改字段：/)).toBeVisible();

	const otherEmail = `e2e_post_edit_other_${Date.now()}@example.com`;
	const otherPassword = "User12345";

	await page.context().clearCookies();
	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(otherEmail);
	await page.getByLabel("昵称").fill("other");
	await page.getByLabel("密码", { exact: true }).fill(otherPassword);
	await page.getByLabel("确认密码").fill(otherPassword);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.goto(`/posts/${postId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("link", { name: "编辑" })).toHaveCount(0);

	const resp = await page.request.get(`/posts/${postId}/edit`);
	expect(resp.status()).toBe(403);
});
