import { test, expect } from "@playwright/test";


function randomFakeIp(prefix: string) {
	return `${prefix}.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
}

async function expectHasAreaNameInput(page: any, name: string) {
	const ok = await page.locator('input[name="name"]').evaluateAll((els: any, value: string) => {
		return els.some((el: any) => String(el?.value || "") === value);
	}, name);
	expect(ok).toBeTruthy();
}

async function expectNoAreaNameInput(page: any, name: string) {
	const ok = await page.locator('input[name="name"]').evaluateAll((els: any, value: string) => {
		return els.some((el: any) => String(el?.value || "") === value);
	}, name);
	expect(ok).toBeFalsy();
}

async function waitForNoAreaNameInput(page: any, name: string, timeoutMs = 8000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const ok = await page.locator('input[name="name"]').evaluateAll((els: any, value: string) => {
			return els.some((el: any) => String(el?.value || "") === value);
		}, name);
		if (!ok) return;
		await page.waitForTimeout(200);
	}
	await expectNoAreaNameInput(page, name);
}

async function getAreaRowByName(page: any, name: string) {
	for (let i = 0; i < 50; i++) {
		const idx = await page.locator("tbody tr").evaluateAll((rows: any, value: string) => {
			for (let j = 0; j < rows.length; j++) {
				const input = rows[j].querySelector('input[name="name"]') as HTMLInputElement | null;
				if (input && String(input.value || "") === value) return j;
			}
			return -1;
		}, name);
		if (typeof idx === "number" && idx >= 0) return page.locator("tbody tr").nth(idx);
		await page.waitForTimeout(200);
	}
	throw new Error(`找不到讨论区行：${name}`);
}

async function expectAreaNameAtIndex(page: any, index: number, name: string) {
	const row = page.locator("tbody tr").nth(index);
	const ok = await row.locator('input[name="name"]').evaluateAll((els: any, value: string) => {
		return els.some((el: any) => String(el?.value || "") === value);
	}, name);
	expect(ok).toBeTruthy();
}

async function registerOrLogin(page: any, args: { email: string; displayName: string; password: string }) {
	const fakeIp = randomFakeIp("10.13");
	await page.setExtraHTTPHeaders({
		"CF-Connecting-IP": fakeIp,
		"X-Forwarded-For": fakeIp,
	});

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

async function fetchAuditLogs(page: any, args: { eventType: string; limit?: number }) {
	const res = await page.request.post("/e2e/audit-logs", {
		data: {
			eventType: args.eventType,
			limit: args.limit ?? 200,
		},
	});
	expect(res.ok()).toBeTruthy();
	const data = (await res.json()) as any;
	expect(data.ok).toBeTruthy();
	return data.logs as any[];
}

async function waitForAuditLog(page: any, args: { eventType: string; predicate: (log: any) => boolean; timeoutMs?: number }) {
	const timeoutMs = args.timeoutMs ?? 8000;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const logs = await fetchAuditLogs(page, { eventType: args.eventType, limit: 200 });
		if (logs.some(args.predicate)) return logs;
		await page.waitForTimeout(200);
	}
	return fetchAuditLogs(page, { eventType: args.eventType, limit: 200 });
}

test("讨论区管理：超管可CRUD/排序/可见性并写入审计日志", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);

	const superadminEmail = "7103308@qq.com";
	const superadminPassword = "Admin123";
	const areaA = `测试区A_${Date.now()}`;
	const areaB = `测试区B_${Date.now()}`;
	const areaBRenamed = `${areaB}_改名`;
	const movedTitle = `移动校验_${Date.now()}`;

	await registerOrLogin(page, { email: superadminEmail, displayName: "superadmin", password: superadminPassword });

	await page.goto("/admin/discussion-areas", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "讨论区管理" })).toBeVisible();

	await page.getByPlaceholder("例如：综合讨论").fill(areaA);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, areaA);

	await page.getByPlaceholder("例如：综合讨论").fill(areaB);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, areaB);

	const rowBBeforeRename = await getAreaRowByName(page, areaB);
	const areaBId = Number(await rowBBeforeRename.locator('input[name="areaId"]').inputValue());
	await rowBBeforeRename.locator('input[name="name"]').fill(areaBRenamed);
	await rowBBeforeRename.getByRole("button", { name: "保存" }).click();
	await expect(page.getByRole("heading", { name: "讨论区管理" })).toBeVisible();
	await expectHasAreaNameInput(page, areaBRenamed);

	const updateLogs = await waitForAuditLog(page, {
		eventType: "discussion_area_updated",
		predicate: (l) => l?.metadata && l.metadata.areaId === areaBId && l.metadata.name === areaBRenamed,
	});
	expect(updateLogs.some((l) => l?.metadata && l.metadata.areaId === areaBId && l.metadata.name === areaBRenamed)).toBeTruthy();

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.selectOption('select[name="areaId"]', { label: areaA });
	await page.locator('input[name="title"]').fill(movedTitle);
	await page.locator('textarea[name="content"]').fill("move");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.goto("/admin/discussion-areas", { waitUntil: "domcontentloaded" });

	const rowB = await getAreaRowByName(page, areaBRenamed);
	await rowB.getByRole("button", { name: "设为隐藏" }).click();
	await expect(page.getByRole("heading", { name: "修改可见性" })).toBeVisible();
	await page.locator('input[name="password"]').fill(superadminPassword);
	await page.getByRole("button", { name: "确认执行" }).click();
	await expect(rowB.getByText("隐藏")).toBeVisible();

	const visibilityLogs = await waitForAuditLog(page, {
		eventType: "discussion_area_visibility_updated",
		predicate: (l) => l?.metadata && typeof l.metadata.areaId === "number" && l.metadata.hidden === 1,
	});
	expect(visibilityLogs.some((l) => l.metadata && typeof l.metadata.areaId === "number" && l.metadata.hidden === 1)).toBeTruthy();

	const rowA = await getAreaRowByName(page, areaA);
	await rowB.dragTo(rowA);
	await expectAreaNameAtIndex(page, 1, areaBRenamed);

	await page.getByRole("button", { name: "保存排序" }).click();
	await expect(page.getByRole("heading", { name: "保存排序" })).toBeVisible();
	await page.locator('input[name="password"]').fill(superadminPassword);
	await page.getByRole("button", { name: "确认执行" }).click();
	await expect(page.getByRole("heading", { name: "讨论区管理" })).toBeVisible();
	await expectAreaNameAtIndex(page, 1, areaBRenamed);

	const rowAAfterReorder = await getAreaRowByName(page, areaA);
	await rowAAfterReorder.getByRole("button", { name: "删除" }).click();
	await expect(page.getByRole("heading", { name: "删除讨论区" })).toBeVisible();
	await page.locator('input[name="password"]').fill(superadminPassword);
	await page.getByRole("button", { name: "确认执行" }).click();
	await expect(page.getByRole("heading", { name: "讨论区管理" })).toBeVisible();
	await waitForNoAreaNameInput(page, areaA);

	const deleteLogs = await waitForAuditLog(page, {
		eventType: "discussion_area_deleted",
		predicate: (l) => l?.metadata && l.metadata.name === areaA,
	});
	const deleted = deleteLogs.find((l) => l?.metadata && l.metadata.name === areaA);
	expect(deleted?.metadata?.movedToAreaId).toBe(1);
	expect(typeof deleted?.metadata?.movedPostCount).toBe("number");
	expect((deleted?.metadata?.movedPostCount ?? 0) >= 1).toBeTruthy();

	await page.goto("/posts", { waitUntil: "domcontentloaded" });
	const noticeSection = page.locator("section", { hasText: "站点公告区" });
	await expect(noticeSection.getByRole("link", { name: movedTitle })).toBeVisible();
});

test("讨论区管理：非超管不可见且访问返回403", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);

	const email = `e2e_user_${Date.now()}@example.com`;
	await registerOrLogin(page, { email, displayName: "e2e_user", password: "User1234" });

	await expect(page.getByRole("link", { name: "讨论区管理" })).toHaveCount(0);
	const resp = await page.goto("/admin/discussion-areas", { waitUntil: "domcontentloaded" });
	expect(resp?.status()).toBe(403);
});

test("置顶作用域：置顶只在所属讨论区内生效；隐藏区普通用户不可发帖", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);

	const superadminEmail = "7103308@qq.com";
	const superadminPassword = "Admin123";
	const area1 = `置顶区_${Date.now()}`;
	const area2 = `普通区_${Date.now()}`;
	const hiddenArea = `隐藏区_${Date.now()}`;
	const title1 = `post_a_${Date.now()}`;
	const title2 = `post_b_${Date.now()}`;

	await registerOrLogin(page, { email: superadminEmail, displayName: "superadmin", password: superadminPassword });
	await page.goto("/admin/discussion-areas", { waitUntil: "domcontentloaded" });

	await page.getByPlaceholder("例如：综合讨论").fill(area1);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, area1);

	await page.getByPlaceholder("例如：综合讨论").fill(area2);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, area2);

	await page.getByPlaceholder("例如：综合讨论").fill(hiddenArea);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, hiddenArea);
	const hiddenRow = await getAreaRowByName(page, hiddenArea);
	await hiddenRow.getByRole("button", { name: "设为隐藏" }).click();
	await expect(page.getByRole("heading", { name: "修改可见性" })).toBeVisible();
	await page.locator('input[name="password"]').fill(superadminPassword);
	await page.getByRole("button", { name: "确认执行" }).click();
	await expect(page.getByRole("heading", { name: "讨论区管理" })).toBeVisible();
	const hiddenRowAfter = await getAreaRowByName(page, hiddenArea);
	await expect(hiddenRowAfter.locator("td").nth(3).getByText("隐藏", { exact: true })).toBeVisible();

	const createdLogs = await fetchAuditLogs(page, { eventType: "discussion_area_created", limit: 50 });
	const hiddenLog = createdLogs.find((l) => l.metadata?.name === hiddenArea);
	expect(typeof hiddenLog?.metadata?.areaId).toBe("number");
	const hiddenAreaId = hiddenLog.metadata.areaId as number;

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.selectOption('select[name="areaId"]', { label: area1 });
	await page.locator('input[name="title"]').fill(title1);
	await page.locator('textarea[name="content"]').fill("a");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.selectOption('select[name="areaId"]', { label: area2 });
	await page.locator('input[name="title"]').fill(title2);
	await page.locator('textarea[name="content"]').fill("b");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.getByRole("link", { name: title1 }).click();
	await expect(page).toHaveURL(/\/posts\//);
	await page.getByRole("button", { name: "永久置顶" }).click();
	await expect(page.getByRole("button", { name: "取消置顶" })).toBeEnabled();

	await page.goto("/posts", { waitUntil: "domcontentloaded" });
	const section1 = page.locator("section", { hasText: area1 });
	await expect(section1.locator("text=置顶").first()).toBeVisible();
	const section2 = page.locator("section", { hasText: area2 });
	await expect(section2.locator("text=置顶")).toHaveCount(0);
	const hiddenSection = page.locator("section", { hasText: hiddenArea });
	await expect(hiddenSection.getByText("隐藏", { exact: true })).toBeVisible();

	await page.goto("/logout", { waitUntil: "domcontentloaded" });
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole("link", { name: "个人中心" })).toHaveCount(0);
	await page.context().clearCookies();
	const userEmail = `e2e_post_user_${Date.now()}@example.com`;
	const userPassword = "User1234";
	await registerOrLogin(page, { email: userEmail, displayName: "e2e_post_user", password: userPassword });
	await expect(page.getByRole("link", { name: "讨论区管理" })).toHaveCount(0);

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await expect(page.locator('select[name="areaId"] option', { hasText: hiddenArea })).toHaveCount(0);

	const forced = await page.evaluate(async ({ hiddenAreaId }) => {
		const body = new URLSearchParams();
		body.set("areaId", String(hiddenAreaId));
		body.set("title", "x");
		body.set("content", "x");
		const resp = await fetch("/posts/new", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
		return { status: resp.status, text: await resp.text() };
	}, { hiddenAreaId });
	expect(forced.status).toBe(403);
	expect(forced.text).toContain("该讨论区已隐藏");
});
