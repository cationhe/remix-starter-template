import { test, expect } from "@playwright/test";

test("个人中心：普通点击与组合键点击都能打开改密弹窗", async ({ page, context }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);
	const openInNewTabModifier = process.platform === "darwin" ? "Meta" : "Control";
	const fakeIp = `10.10.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
	const email = `e2e_${Date.now()}@example.com`;
	const oldPassword = "Abcdef1";
	const newPassword = "XyZ9876";
	await page.setExtraHTTPHeaders({
		"CF-Connecting-IP": fakeIp,
		"X-Forwarded-For": fakeIp,
	});

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("昵称").fill("e2e");
	await page.getByLabel("密码", { exact: true }).fill(oldPassword);
	await page.getByLabel("确认密码").fill(oldPassword);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);
	await page.getByRole("link", { name: "个人中心" }).click();
	await expect(page.getByRole("heading", { name: "个人中心" })).toBeVisible();

	await page.getByRole("link", { name: "修改密码" }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page).toHaveURL(/\/me\/password/);

	await page.getByLabel("旧密码").fill("wrong");
	await page.getByLabel("新密码", { exact: true }).fill(newPassword);
	await page.getByLabel("确认新密码").fill(newPassword);
	const submitButton = page.getByRole("button", { name: "确认修改" });
	await expect(submitButton).toBeVisible();
	await expect(submitButton).toBeEnabled();
	await submitButton.evaluate((el) => {
		el.scrollIntoView({ block: "center", inline: "center" });
	});
	await submitButton.click({ force: true });
	await expect(page.getByText("旧密码不正确")).toBeVisible();

	await page.getByLabel("旧密码").fill(oldPassword);
	await page.getByLabel("新密码", { exact: true }).fill(newPassword);
	await page.getByLabel("确认新密码").fill(newPassword);
	await expect(submitButton).toBeEnabled();
	await submitButton.evaluate((el) => {
		el.scrollIntoView({ block: "center", inline: "center" });
	});
	await submitButton.click({ force: true });
	await expect(page).toHaveURL(/\/me\?pwdChanged=1/);
	await expect(page.getByText("密码已修改，请使用新密码登录")).toBeVisible();

	await page.context().clearCookies();
	await page.goto("/login", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("密码").fill(newPassword);
	await page.getByRole("button", { name: "登录" }).click();
	await expect(page).toHaveURL(/\/$/);
	await page.getByRole("link", { name: "个人中心" }).click();
	await expect(page.getByRole("heading", { name: "个人中心" })).toBeVisible();
	const newPagePromise = context.waitForEvent("page");
	await page
		.getByRole("link", { name: "修改密码" })
		.click({ modifiers: [openInNewTabModifier] });
	const newTab = await newPagePromise;
	await newTab.waitForLoadState("domcontentloaded");
	await expect(newTab).toHaveURL(/\/me\/password/);
	await expect(newTab.getByRole("dialog")).toBeVisible();
});

test("管理员重置临时密码后：个人中心不再刷新且可完成强制改密", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);
	const fakeIp = `10.11.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
	await page.setExtraHTTPHeaders({
		"CF-Connecting-IP": fakeIp,
		"X-Forwarded-For": fakeIp,
	});

	const superadminEmail = "7103308@qq.com";
	const superadminPassword = "Admin123";
	const userEmail = `e2e_user_${Date.now()}@example.com`;
	const userPassword = "User1234";
	const userNewPassword = "New1234";
	const tempPassword = "123456";

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(userEmail);
	await page.getByLabel("昵称").fill("e2e_user");
	await page.getByLabel("密码", { exact: true }).fill(userPassword);
	await page.getByLabel("确认密码").fill(userPassword);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);
	await page.context().clearCookies();

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(superadminEmail);
	await page.getByLabel("昵称").fill("superadmin");
	await page.getByLabel("密码", { exact: true }).fill(superadminPassword);
	await page.getByLabel("确认密码").fill(superadminPassword);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.goto("/admin/users", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();

	page.once("dialog", async (dialog) => {
		await dialog.accept();
	});
	const userRow = page.getByRole("row", { name: new RegExp(userEmail) });
	await userRow.getByRole("button", { name: "重置密码" }).click();
	await expect(page).toHaveURL(/\/admin\/users/);
	await expect(userRow).toContainText(/分\d{2}秒/);

	await page.context().clearCookies();
	await page.goto("/login", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(userEmail);
	await page.getByLabel("密码").fill(tempPassword);
	await page.getByRole("button", { name: "登录" }).click();
	await expect(page).toHaveURL(/\/me\/password\?force=1/, { timeout: 20000 });
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.waitForTimeout(1200);
	await expect(page).toHaveURL(/\/me\/password\?force=1/);

	await page.getByLabel("新密码", { exact: true }).fill(userNewPassword);
	await page.getByLabel("确认新密码").fill(userNewPassword);
	await page.getByRole("button", { name: "确认修改" }).click({ force: true });
	await expect(page).toHaveURL(/\/me\?pwdChanged=1/);
});
