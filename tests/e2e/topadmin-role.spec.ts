import { test, expect } from "@playwright/test";

function randomFakeIp(prefix: string) {
	return `${prefix}.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
}

test("topadmin 可修改 superadmin 账户等级并写入审计日志", async ({ page }) => {
	await page.setExtraHTTPHeaders({
		"CF-Connecting-IP": randomFakeIp("10"),
		"X-Forwarded-For": randomFakeIp("10"),
	});

	const topadminEmail = "7103308@qq.com";
	const topadminPassword = "Topadmin123";
	const userEmail = `u_${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`;
	const userPassword = "User12345";

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(topadminEmail);
	await page.getByLabel("昵称").fill("topadmin");
	await page.getByLabel("密码", { exact: true }).fill(topadminPassword);
	await page.getByLabel("确认密码").fill(topadminPassword);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.context().clearCookies();
	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(userEmail);
	await page.getByLabel("昵称").fill("user");
	await page.getByLabel("密码", { exact: true }).fill(userPassword);
	await page.getByLabel("确认密码").fill(userPassword);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.context().clearCookies();
	await page.goto("/login", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(topadminEmail);
	await page.getByLabel("密码").fill(topadminPassword);
	await page.getByRole("button", { name: "登录" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.goto("/admin/users", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();

	const userRow = page.getByRole("row", { name: new RegExp(userEmail) });
	await userRow.getByRole("button", { name: "修改" }).click();
	await expect(page.getByRole("heading", { name: "修改角色" })).toBeVisible();
	await page.getByLabel("目标角色").selectOption("superadmin");
	await page.getByLabel("二次验证密码").fill(topadminPassword);
	await page.getByRole("button", { name: "确认修改" }).click();
	await expect(page.getByRole("heading", { name: "修改角色" })).toBeHidden();

	const userRowAfterPromote = page.getByRole("row", { name: new RegExp(userEmail) });
	await expect(userRowAfterPromote).toContainText("superadmin");

	await userRowAfterPromote.getByRole("button", { name: "修改" }).click();
	await expect(page.getByRole("heading", { name: "修改角色" })).toBeVisible();
	await page.getByLabel("目标角色").selectOption("admin");
	await page.getByLabel("二次验证密码").fill(topadminPassword);
	await page.getByRole("button", { name: "确认修改" }).click();
	await expect(page.getByRole("heading", { name: "修改角色" })).toBeHidden();

	const userRowAfterDowngrade = page.getByRole("row", { name: new RegExp(userEmail) });
	await expect(userRowAfterDowngrade).toContainText("admin");

	const auditResp = await page.request.post("/e2e/audit-logs", {
		data: { eventType: "user_role_updated", limit: 200 },
	});
	expect(auditResp.ok()).toBeTruthy();
	const auditBody = (await auditResp.json()) as any;
	expect(auditBody.ok).toBeTruthy();
	const logs = Array.isArray(auditBody.logs) ? auditBody.logs : [];
	const promoteLog = logs.find((l: any) => {
		return l?.eventType === "user_role_updated" && l?.metadata?.targetEmail === userEmail && l?.metadata?.nextRole === "superadmin";
	});
	expect(Boolean(promoteLog)).toBeTruthy();
	const targetUserIdFromLog = Number(promoteLog?.metadata?.targetUserId ?? 0);
	expect(targetUserIdFromLog > 0).toBeTruthy();

	const warnResp = await page.request.post("/e2e/audit-logs", {
		data: { eventType: "superadmin_role_change_warning", limit: 200 },
	});
	expect(warnResp.ok()).toBeTruthy();
	const warnBody = (await warnResp.json()) as any;
	expect(warnBody.ok).toBeTruthy();
	const warnLogs = Array.isArray(warnBody.logs) ? warnBody.logs : [];
	const hasWarnLog = warnLogs.some((l: any) => {
		return l?.eventType === "superadmin_role_change_warning" && Number(l?.metadata?.targetUserId ?? 0) === targetUserIdFromLog;
	});
	expect(hasWarnLog).toBeTruthy();
});
