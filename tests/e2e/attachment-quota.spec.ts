import { test, expect } from "@playwright/test";

test("站点附件总存储超过 9GB 时：作者侧上传入口禁用并提示", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);
	const fakeIp = `10.12.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
	await page.setExtraHTTPHeaders({
		"CF-Connecting-IP": fakeIp,
		"X-Forwarded-For": fakeIp,
	});

	const email = `e2e_quota_${Date.now()}@example.com`;
	const password = "User1234";
	const title = `quota_post_${Date.now()}`;

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("昵称").fill("e2e_quota");
	await page.getByLabel("密码", { exact: true }).fill(password);
	await page.getByLabel("确认密码").fill(password);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.locator('input[name="title"]').fill(title);
	await page.locator('textarea[name="content"]').fill("quota");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.getByRole("link", { name: title }).click();
	await expect(page).toHaveURL(/\/posts\//);

	await expect(page.getByText("网站总存储量已超过 9GB，已暂停附件上传")).toBeVisible();
	await expect(page.locator('input[type="file"]')).toBeDisabled();
	await expect(page.getByRole("button", { name: "开始上传" })).toBeDisabled();
});
