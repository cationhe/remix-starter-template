import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 180000,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : 1,
	use: {
		baseURL: "http://127.0.0.1:8788",
		navigationTimeout: 120000,
		actionTimeout: 60000,
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"CI=1 npm run build && rm -rf .wrangler/state/v3/d1/miniflare-D1DatabaseObject && printf 'y\n' | CI=1 npx wrangler d1 migrations apply forum_db --local --config wrangler.json && CI=1 npx wrangler dev --port 8788 --ip 127.0.0.1 --var EMAIL_PROVIDER:disabled --var E2E:1 --config wrangler.json",
		url: "http://127.0.0.1:8788",
		reuseExistingServer: false,
		timeout: 180000,
	},
});
