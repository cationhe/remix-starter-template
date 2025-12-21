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
			"CI=1 npm run build && rm -rf .wrangler/state/v3/d1/miniflare-D1DatabaseObject && printf 'y\\n' | CI=1 npx wrangler d1 migrations apply forum_db --local --config wrangler.json && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json --command \"PRAGMA foreign_keys=ON; INSERT OR IGNORE INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (900001, 'quota_seed@example.com', 'seed', 'x', 'y', 0); INSERT OR IGNORE INTO posts (id, title, content, author_id, created_at, updated_at) VALUES (900001, 'seed', 'seed', 900001, 0, 0); INSERT OR IGNORE INTO attachments (post_id, uploader_id, r2_key, filename, mime_type, size_bytes, created_at) VALUES (900001, 900001, 'seed/quota_full', 'seed.bin', 'application/octet-stream', 9663676416, 0);\" && CI=1 npx wrangler dev --port 8788 --ip 127.0.0.1 --var EMAIL_PROVIDER:disabled --config wrangler.json",
		url: "http://127.0.0.1:8788",
		reuseExistingServer: false,
		timeout: 180000,
	},
});
