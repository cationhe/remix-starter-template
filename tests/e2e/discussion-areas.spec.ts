import { test, expect } from "@playwright/test";


function randomFakeIp(prefix: string) {
	return `${prefix}.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
}

function getDialogByTitle(page: any, title: string) {
	return page.locator("div.fixed.inset-0").filter({ has: page.getByRole("heading", { name: title }) });
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

async function getAreaRowIndexByName(page: any, name: string) {
	for (let i = 0; i < 50; i++) {
		const idx = await page.locator("tbody tr").evaluateAll((rows: any, value: string) => {
			for (let j = 0; j < rows.length; j++) {
				const input = rows[j].querySelector('input[name="name"]') as HTMLInputElement | null;
				if (input && String(input.value || "") === value) return j;
			}
			return -1;
		}, name);
		if (typeof idx === "number" && idx >= 0) return idx;
		await page.waitForTimeout(200);
	}
	throw new Error(`找不到讨论区索引：${name}`);
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
	await getDialogByTitle(page, "修改可见性").locator('input[name="password"]').fill(superadminPassword);
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
	await getDialogByTitle(page, "保存排序").locator('input[name="password"]').fill(superadminPassword);
	await page.getByRole("button", { name: "确认执行" }).click();
	await expect(page.getByRole("heading", { name: "讨论区管理" })).toBeVisible();
	await expectAreaNameAtIndex(page, 1, areaBRenamed);

	const rowAAfterReorder = await getAreaRowByName(page, areaA);
	await rowAAfterReorder.getByRole("button", { name: "删除" }).click();
	await expect(page.getByRole("heading", { name: "删除讨论区" })).toBeVisible();
	await getDialogByTitle(page, "删除讨论区").locator('input[name="password"]').fill(superadminPassword);
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
	await getDialogByTitle(page, "修改可见性").locator('input[name="password"]').fill(superadminPassword);
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

test("讨论区详情页：可从讨论区名称进入，支持分页与搜索", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);

	const superadminEmail = "7103308@qq.com";
	const superadminPassword = "Admin123";
	const areaName = `详情页区_${Date.now()}`;

	await registerOrLogin(page, { email: superadminEmail, displayName: "superadmin", password: superadminPassword });
	await page.goto("/admin/discussion-areas", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "讨论区管理" })).toBeVisible();
	await page.getByPlaceholder("例如：综合讨论").fill(areaName);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, areaName);
	const row = await getAreaRowByName(page, areaName);
	const areaId = Number(await row.locator('input[name="areaId"]').inputValue());
	expect(Number.isFinite(areaId)).toBeTruthy();
	const base = Date.now();
	const specialKeyword = `special_kw_${base}`;
	const titles = Array.from({ length: 23 }, (_, i) => `分页帖_${base}_${i}`);
	await page.evaluate(
		async ({ areaId, titles, specialKeyword }) => {
			for (let i = 0; i < titles.length; i++) {
				const body = new URLSearchParams();
				body.set("areaId", String(areaId));
				body.set("title", titles[i]);
				body.set("content", i === 10 ? `hello ${specialKeyword} world` : `content_${i}`);
				const resp = await fetch("/posts/new", {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body,
				});
				if (resp.status >= 400) {
					throw new Error(`unexpected status: ${resp.status}`);
				}
			}
		},
		{ areaId, titles, specialKeyword },
	);

	await page.goto("/posts", { waitUntil: "domcontentloaded" });
	await page.getByRole("link", { name: areaName }).click();
	await expect(page).toHaveURL(new RegExp(`/areas/${areaId}(\\?.*)?$`));
	await expect(page.getByRole("heading", { name: areaName })).toBeVisible();
	await expect(page.getByText("第 1 / 2 页")).toBeVisible();
	await expect(page.locator("ul > li")).toHaveCount(20);
	await expect(page.getByRole("link", { name: titles[titles.length - 1] })).toBeVisible();

	await page.getByRole("link", { name: "下一页" }).click();
	await expect(page).toHaveURL(new RegExp(`/areas/${areaId}\\?page=2`));
	await expect(page.getByText("第 2 / 2 页")).toBeVisible();
	await expect(page.locator("ul > li")).toHaveCount(3);

	await page.getByPlaceholder("搜索标题或内容").fill(specialKeyword);
	await page.getByRole("button", { name: "搜索" }).click();
	await expect(page).toHaveURL(new RegExp(`/areas/${areaId}\\?.*q=`));
	await expect(page.getByText("共 1 帖")).toBeVisible();
	await expect(page.locator("ul > li")).toHaveCount(1);
	await expect(page.getByRole("link", { name: titles[10] })).toBeVisible();
	await page.getByRole("link", { name: titles[10] }).click();
	await expect(page).toHaveURL(/\/posts\//);
});

test("讨论区详情页：发帖入口锁定讨论区", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);

	const superadminEmail = "7103308@qq.com";
	const superadminPassword = "Admin123";
	const areaName = `锁定发帖区_${Date.now()}`;
	const title = `锁定发帖_${Date.now()}`;

	await registerOrLogin(page, { email: superadminEmail, displayName: "superadmin", password: superadminPassword });
	await page.goto("/admin/discussion-areas", { waitUntil: "domcontentloaded" });
	await page.getByPlaceholder("例如：综合讨论").fill(areaName);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, areaName);
	const row = await getAreaRowByName(page, areaName);
	const areaId = Number(await row.locator('input[name="areaId"]').inputValue());
	expect(areaId > 0).toBeTruthy();

	await page.goto("/posts", { waitUntil: "domcontentloaded" });
	await page.getByRole("link", { name: areaName }).click();
	await expect(page).toHaveURL(new RegExp(`/areas/${areaId}(\\?.*)?$`));
	await expect(page.getByRole("heading", { name: areaName })).toBeVisible();

	await page.getByRole("link", { name: "发帖" }).click();
	await expect(page).toHaveURL(new RegExp(`/posts/new\\?areaId=${areaId}`));
	await expect(page.locator('select[name="areaId"]')).toHaveCount(0);
	await expect(page.locator(`input[disabled][value="${areaName}"]`)).toBeVisible();

	await page.locator('input[name="title"]').fill(title);
	await page.locator('textarea[name="content"]').fill("locked");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(new RegExp(`/areas/${areaId}(\\?.*)?$`));
	await expect(page.getByRole("link", { name: title })).toBeVisible();
});

test("讨论区详情页：隐藏讨论区普通用户访问返回404", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);

	const superadminEmail = "7103308@qq.com";
	const superadminPassword = "Admin123";
	const hiddenArea = `隐藏详情页区_${Date.now()}`;

	await registerOrLogin(page, { email: superadminEmail, displayName: "superadmin", password: superadminPassword });
	await page.goto("/admin/discussion-areas", { waitUntil: "domcontentloaded" });
	await page.getByPlaceholder("例如：综合讨论").fill(hiddenArea);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, hiddenArea);
	const hiddenRow = await getAreaRowByName(page, hiddenArea);
	const hiddenAreaId = Number(await hiddenRow.locator('input[name="areaId"]').inputValue());
	await hiddenRow.getByRole("button", { name: "设为隐藏" }).click();
	await expect(page.getByRole("heading", { name: "修改可见性" })).toBeVisible();
	await getDialogByTitle(page, "修改可见性").locator('input[name="password"]').fill(superadminPassword);
	await page.getByRole("button", { name: "确认执行" }).click();
	await expect(page.getByRole("heading", { name: "讨论区管理" })).toBeVisible();
	const hiddenRowAfter = await getAreaRowByName(page, hiddenArea);
	await expect(hiddenRowAfter.locator("td").nth(3).getByText("隐藏", { exact: true })).toBeVisible();

	await page.goto("/logout", { waitUntil: "domcontentloaded" });
	await expect(page).toHaveURL(/\/$/);
	await page.context().clearCookies();
	const email = `e2e_area_user_${Date.now()}@example.com`;
	await registerOrLogin(page, { email, displayName: "e2e_area_user", password: "User1234" });
	const resp = await page.goto(`/areas/${hiddenAreaId}`, { waitUntil: "domcontentloaded" });
	expect(resp?.status()).toBe(404);
});

test("讨论区管理：topadmin 可调整讨论区顺序并写入审计日志", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);

	const topadminEmail = "e2e_topadmin@example.com";
	const topadminPassword = "Topadmin123";
	const areaA = `topadmin排序A_${Date.now()}`;
	const areaB = `topadmin排序B_${Date.now()}`;
	const start = Date.now();

	await registerOrLogin(page, { email: topadminEmail, displayName: "topadmin", password: topadminPassword });
	await page.goto("/admin/discussion-areas", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "讨论区管理" })).toBeVisible();

	await page.getByPlaceholder("例如：综合讨论").fill(areaA);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, areaA);

	await page.getByPlaceholder("例如：综合讨论").fill(areaB);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, areaB);

	const rowA = await getAreaRowByName(page, areaA);
	const areaAId = Number(await rowA.locator('input[name="areaId"]').inputValue());
	const rowB = await getAreaRowByName(page, areaB);
	const areaBId = Number(await rowB.locator('input[name="areaId"]').inputValue());

	const indexABefore = await getAreaRowIndexByName(page, areaA);
	const indexBBefore = await getAreaRowIndexByName(page, areaB);
	await rowB.dragTo(rowA);
	const indexAAfterDrag = await getAreaRowIndexByName(page, areaA);
	const indexBAfterDrag = await getAreaRowIndexByName(page, areaB);
	expect(indexABefore).not.toBe(indexAAfterDrag);
	expect(indexBBefore).not.toBe(indexBAfterDrag);
	expect(indexBAfterDrag).toBeLessThan(indexAAfterDrag);

	await page.getByRole("button", { name: "保存排序" }).click();
	await expect(page.getByRole("heading", { name: "保存排序" })).toBeVisible();
	await getDialogByTitle(page, "保存排序").locator('input[name="password"]').fill(topadminPassword);
	await page.getByRole("button", { name: "确认执行" }).click();
	await expect(page.getByRole("heading", { name: "讨论区管理" })).toBeVisible();
	const indexAAfterSave = await getAreaRowIndexByName(page, areaA);
	const indexBAfterSave = await getAreaRowIndexByName(page, areaB);
	expect(indexBAfterSave).toBeLessThan(indexAAfterSave);

	const reorderLogs = await waitForAuditLog(page, {
		eventType: "discussion_area_reordered",
		predicate: (l) => {
			const order = l?.metadata?.order;
			return (
				Number(l?.createdAt ?? 0) >= start &&
				Array.isArray(order) &&
				order.includes(areaAId) &&
				order.includes(areaBId)
			);
		},
	});
	expect(
		reorderLogs.some((l) => {
			const order = l?.metadata?.order;
			return (
				Number(l?.createdAt ?? 0) >= start &&
				Array.isArray(order) &&
				order.includes(areaAId) &&
				order.includes(areaBId)
			);
		}),
	).toBeTruthy();
});

test("置顶：topadmin 可置顶/取消置顶并写入审计日志", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);

	const topadminEmail = "e2e_topadmin@example.com";
	const topadminPassword = "Topadmin123";
	const title = `topadmin置顶_${Date.now()}`;
	const start = Date.now();

	await registerOrLogin(page, { email: topadminEmail, displayName: "topadmin", password: topadminPassword });
	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.locator('input[name="title"]').fill(title);
	await page.locator('textarea[name="content"]').fill("pin as topadmin");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.getByRole("link", { name: title }).click();
	await expect(page).toHaveURL(/\/posts\//);
	await page.getByRole("button", { name: "永久置顶" }).click();
	await expect(page.getByRole("button", { name: "取消置顶" })).toBeEnabled();

	const postId = (() => {
		const m = page.url().match(/\/posts\/(\d+)/);
		return m ? Number(m[1]) : 0;
	})();
	expect(postId > 0).toBeTruthy();

	const pinLogs = await waitForAuditLog(page, {
		eventType: "post_pin_set",
		predicate: (l) => {
			return Number(l?.createdAt ?? 0) >= start && l?.metadata?.postId === postId && l?.metadata?.pinnedUntilMs === 0;
		},
	});
	expect(
		pinLogs.some((l) => {
			return Number(l?.createdAt ?? 0) >= start && l?.metadata?.postId === postId && l?.metadata?.pinnedUntilMs === 0;
		}),
	).toBeTruthy();

	await page.getByRole("button", { name: "取消置顶" }).click();
	await expect(page.getByRole("button", { name: "永久置顶" })).toBeEnabled();

	const unpinLogs = await waitForAuditLog(page, {
		eventType: "post_pin_set",
		predicate: (l) => {
			return Number(l?.createdAt ?? 0) >= start && l?.metadata?.postId === postId && l?.metadata?.pinnedUntilMs === null;
		},
	});
	expect(
		unpinLogs.some((l) => {
			return Number(l?.createdAt ?? 0) >= start && l?.metadata?.postId === postId && l?.metadata?.pinnedUntilMs === null;
		}),
	).toBeTruthy();
});

test("帖子移区：超管可从帖子页无刷新移区并写入审计日志", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);

	const superadminEmail = "7103308@qq.com";
	const superadminPassword = "Admin123";
	const fromAreaName = `移区来源_${Date.now()}`;
	const toAreaName = `移区目标_${Date.now()}`;
	const title = `移区帖_${Date.now()}`;
	const start = Date.now();

	await registerOrLogin(page, { email: superadminEmail, displayName: "superadmin", password: superadminPassword });
	await page.goto("/admin/discussion-areas", { waitUntil: "domcontentloaded" });

	await page.getByPlaceholder("例如：综合讨论").fill(fromAreaName);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, fromAreaName);
	const fromRow = await getAreaRowByName(page, fromAreaName);
	const fromAreaId = Number(await fromRow.locator('input[name="areaId"]').inputValue());
	expect(fromAreaId > 0).toBeTruthy();

	await page.getByPlaceholder("例如：综合讨论").fill(toAreaName);
	await page.getByRole("button", { name: "创建" }).click();
	await expectHasAreaNameInput(page, toAreaName);
	const toRow = await getAreaRowByName(page, toAreaName);
	const toAreaId = Number(await toRow.locator('input[name="areaId"]').inputValue());
	expect(toAreaId > 0).toBeTruthy();

	await page.goto(`/posts/new?areaId=${fromAreaId}`, { waitUntil: "domcontentloaded" });
	await page.locator('input[name="title"]').fill(title);
	await page.locator('textarea[name="content"]').fill("migrate");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(new RegExp(`/areas/${fromAreaId}(\\?.*)?$`));
	await page.getByRole("link", { name: title }).click();
	await expect(page).toHaveURL(/\/posts\//);

	const postId = (() => {
		const m = page.url().match(/\/posts\/(\d+)/);
		return m ? Number(m[1]) : 0;
	})();
	expect(postId > 0).toBeTruthy();

	await expect(page.getByText("管理操作")).toBeVisible();
	const migrateButton = page.getByRole("button", { name: "移区" });
	await expect(migrateButton).toBeVisible();
	await expect(migrateButton).toHaveAttribute("title", "将帖子移动到其他分区");
	await migrateButton.click();

	const dialog = getDialogByTitle(page, "移动到其他分区");
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: new RegExp(toAreaName) }).click();
	await dialog.getByRole("button", { name: "确认移动" }).click();

	await expect(page.getByText(`移区成功：${toAreaName}`)).toBeVisible();
	await expect(dialog).toHaveCount(0);

	await page.goto(`/areas/${toAreaId}`, { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("link", { name: title })).toBeVisible();

	const migrateLogs = await waitForAuditLog(page, {
		eventType: "post_migrated_to_area",
		predicate: (l) => {
			return (
				Number(l?.createdAt ?? 0) >= start &&
				l?.metadata?.postId === postId &&
				l?.metadata?.fromAreaId === fromAreaId &&
				l?.metadata?.toAreaId === toAreaId
			);
		},
	});
	expect(
		migrateLogs.some((l) => {
			return (
				Number(l?.createdAt ?? 0) >= start &&
				l?.metadata?.postId === postId &&
				l?.metadata?.fromAreaId === fromAreaId &&
				l?.metadata?.toAreaId === toAreaId
			);
		}),
	).toBeTruthy();
});

test("删帖：超管删除已编辑帖子不应触发外键约束失败", async ({ page }) => {
	test.setTimeout(180000);
	page.setDefaultNavigationTimeout(120000);

	const superadminEmail = "7103308@qq.com";
	const superadminPassword = "Admin123";
	const title = `删帖外键_${Date.now()}`;
	const editedTitle = `${title}_已编辑`;
	const start = Date.now();

	await registerOrLogin(page, { email: superadminEmail, displayName: "superadmin", password: superadminPassword });

	await page.goto("/posts/new", { waitUntil: "domcontentloaded" });
	await page.locator('input[name="title"]').fill(title);
	await page.locator('textarea[name="content"]').fill("delete fk");
	await page.getByRole("button", { name: "发布" }).click();
	await expect(page).toHaveURL(/\/posts$/);

	await page.getByRole("link", { name: title }).click();
	await expect(page).toHaveURL(/\/posts\//);

	const postId = (() => {
		const m = page.url().match(/\/posts\/(\d+)/);
		return m ? Number(m[1]) : 0;
	})();
	expect(postId > 0).toBeTruthy();

	await page.getByRole("link", { name: "编辑" }).click();
	await expect(page).toHaveURL(new RegExp(`/posts/${postId}/edit`));
	await expect(page.getByRole("heading", { name: "编辑帖子" })).toBeVisible();
	await page.locator('input[name="title"]').fill(editedTitle);
	await page.locator('input[name="confirm"][type="checkbox"]').check();
	await page.getByRole("button", { name: "保存" }).click();
	await expect(page).toHaveURL(new RegExp(`/posts/${postId}(\\?.*)?$`));
	await expect(page.getByRole("heading", { name: editedTitle })).toBeVisible();

	await page.getByRole("button", { name: "删帖" }).click();
	await expect(page).toHaveURL(/\/posts$/);
	await expect(page.getByRole("link", { name: editedTitle })).toHaveCount(0);

	const logs = await waitForAuditLog(page, {
		eventType: "post_deleted",
		predicate: (l) => Number(l?.createdAt ?? 0) >= start && l?.metadata?.postId === postId,
	});
	expect(logs.some((l) => Number(l?.createdAt ?? 0) >= start && l?.metadata?.postId === postId)).toBeTruthy();
});
