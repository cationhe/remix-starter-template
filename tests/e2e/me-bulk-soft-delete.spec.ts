import { test, expect } from "@playwright/test";

test("个人中心：我的帖子/评论支持批量软删除并影响列表展示", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);
	const fakeIp = `10.20.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
	await page.setExtraHTTPHeaders({
		"CF-Connecting-IP": fakeIp,
		"X-Forwarded-For": fakeIp,
	});

	const email = `e2e_me_bulk_${Date.now()}@example.com`;
	const password = "User1234";
	const title1 = `bulk_post_1_${Date.now()}`;
	const title2 = `bulk_post_2_${Date.now()}`;

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("昵称").fill("e2e_me");
	await page.getByLabel("密码", { exact: true }).fill(password);
	await page.getByLabel("确认密码").fill(password);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.locator('input[name="title"]').fill(title1);
	await page.locator('textarea[name="content"]').fill("a");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.locator('input[name="title"]').fill(title2);
	await page.locator('textarea[name="content"]').fill("b");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.goto("/me/posts", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "我的帖子管理" })).toBeVisible();
	await page.locator('thead input[type="checkbox"]').check();
	await page.getByRole("button", { name: /删除所选/ }).click();
	await expect(page.getByText("暂无数据")).toBeVisible();

	await page.goto("/posts", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("link", { name: title1 })).toHaveCount(0);
	await expect(page.getByRole("link", { name: title2 })).toHaveCount(0);

	const title3 = `bulk_post_3_${Date.now()}`;
	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.locator('input[name="title"]').fill(title3);
	await page.locator('textarea[name="content"]').fill("c");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);
	await page.getByRole("link", { name: title3 }).click();
	await expect(page).toHaveURL(/\/posts\//);
	await page.locator('textarea[name="content"]').fill("comment_1");
	await page.getByRole("button", { name: "提交评论" }).click();
	await page.locator('textarea[name="content"]').fill("comment_2");
	await page.getByRole("button", { name: "提交评论" }).click();
	await expect(page.getByText(/评论[:：]\s*2/)).toBeVisible();

	await page.goto("/me/comments", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "我的评论管理" })).toBeVisible();
	await page.locator('thead input[type="checkbox"]').check();
	await page.getByRole("button", { name: /删除所选/ }).click();
	await expect(page.getByText("暂无数据")).toBeVisible();

	await page.getByRole("link", { name: "我的帖子管理" }).first().click();
	await expect(page.getByRole("heading", { name: "我的帖子管理" })).toBeVisible();

	await page.goto(page.url().replace(/\/me\/posts.*$/, `/posts`), { waitUntil: "domcontentloaded" });
	await page.getByRole("link", { name: title3 }).click();
	await expect(page.getByText(/评论[:：]\s*0/)).toBeVisible();

	const auditPosts = await page.request.post("/e2e/audit-logs", {
		data: { eventType: "me_posts_soft_deleted", limit: 50 },
	});
	expect(auditPosts.ok()).toBeTruthy();
	const auditPostsJson = (await auditPosts.json()) as any;
	expect(auditPostsJson.ok).toBeTruthy();
	expect(Array.isArray(auditPostsJson.logs)).toBeTruthy();
	expect(auditPostsJson.logs.some((l: any) => l.eventType === "me_posts_soft_deleted")).toBeTruthy();

	const auditComments = await page.request.post("/e2e/audit-logs", {
		data: { eventType: "me_comments_soft_deleted", limit: 50 },
	});
	expect(auditComments.ok()).toBeTruthy();
	const auditCommentsJson = (await auditComments.json()) as any;
	expect(auditCommentsJson.ok).toBeTruthy();
	expect(Array.isArray(auditCommentsJson.logs)).toBeTruthy();
	expect(auditCommentsJson.logs.some((l: any) => l.eventType === "me_comments_soft_deleted")).toBeTruthy();
});
