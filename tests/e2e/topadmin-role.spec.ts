import { test, expect } from "@playwright/test";

function randomFakeIp(prefix: string) {
	return `${prefix}.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
}

async function registerOrLogin(page: any, args: { email: string; displayName: string; password: string }) {
	await page.goto("/login", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(args.email);
	await page.getByLabel("密码").fill(args.password);
	await page.getByRole("button", { name: "登录" }).click();
	try {
		await expect(page).toHaveURL(/\/(|me\/password\?force=1)$/, { timeout: 8000 });
		return;
	} catch {
	}

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await page.getByLabel("邮箱").fill(args.email);
	await page.getByLabel("昵称").fill(args.displayName);
	await page.getByLabel("密码", { exact: true }).fill(args.password);
	await page.getByLabel("确认密码").fill(args.password);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/, { timeout: 20000 });
}

test("topadmin 可修改 superadmin 账户等级并写入审计日志", async ({ page }) => {
	await page.setExtraHTTPHeaders({
		"CF-Connecting-IP": randomFakeIp("10"),
		"X-Forwarded-For": randomFakeIp("10"),
	});

	const topadminEmail = "e2e_topadmin@example.com";
	const topadminPassword = "Topadmin123";
	const userEmail = `u_${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`;
	const userPassword = "User12345";

	await registerOrLogin(page, { email: topadminEmail, displayName: "topadmin", password: topadminPassword });

	await page.context().clearCookies();
	await registerOrLogin(page, { email: userEmail, displayName: "user", password: userPassword });

	await page.context().clearCookies();
	await registerOrLogin(page, { email: topadminEmail, displayName: "topadmin", password: topadminPassword });

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
