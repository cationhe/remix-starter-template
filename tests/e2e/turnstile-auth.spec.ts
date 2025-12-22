import { test, expect, type Page } from "@playwright/test";

async function ensureTurnstileToken(page: Page, flow: "login" | "register") {
	const tokenInput = page.locator('input[name="cf-turnstile-response"]');
	await expect(tokenInput).toHaveCount(1);
	try {
		await expect(tokenInput).toHaveValue(/\S+/, { timeout: 8000 });
		return;
	} catch {
		const token = `e2e_${Date.now()}`;
		const fnName = flow === "login" ? "__turnstileLoginSuccess" : "__turnstileRegisterSuccess";
		await page.waitForFunction((name) => typeof (window as any)[name] === "function", fnName, {
			timeout: 8000,
		});
		await page.evaluate(
			({ token, flow }: { token: string; flow: "login" | "register" }) => {
				const w = window as any;
				const fn = flow === "login" ? w.__turnstileLoginSuccess : w.__turnstileRegisterSuccess;
				if (typeof fn === "function") fn(token);
			},
			{ token, flow },
		);
		await expect(tokenInput).toHaveValue(token, { timeout: 2000 });
	}
}

test("登录/注册：首次访问强制展示真人校验并可通过后继续", async ({ page }) => {
	await page.context().setExtraHTTPHeaders({ "x-e2e-turnstile-enforce": "1" });
	const email = `e2e_turnstile_${Date.now()}@example.com`;
	const password = "User1234";

	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await expect(page.locator(".cf-turnstile")).toBeVisible();
	await ensureTurnstileToken(page, "register");
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("昵称").fill("e2e");
	await page.getByLabel("密码", { exact: true }).fill(password);
	await page.getByLabel("确认密码").fill(password);
	await page.getByRole("button", { name: "注册" }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.context().clearCookies();
	await page.goto("/login", { waitUntil: "domcontentloaded" });
	await expect(page.locator(".cf-turnstile")).toBeVisible();
	await ensureTurnstileToken(page, "login");
	await page.getByLabel("邮箱").fill(email);
	await page.getByLabel("密码").fill(password);
	await page.getByRole("button", { name: "登录" }).click();
	await expect(page).toHaveURL(/\/$/);
});

test("注册：刷新页面后真人校验需要重新获得 token", async ({ page }) => {
	await page.context().setExtraHTTPHeaders({ "x-e2e-turnstile-enforce": "1" });
	await page.goto("/register", { waitUntil: "domcontentloaded" });
	await expect(page.locator(".cf-turnstile")).toBeVisible();
	await ensureTurnstileToken(page, "register");

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.locator(".cf-turnstile")).toBeVisible();
	await ensureTurnstileToken(page, "register");
});
