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
			"CI=1 npm run build && rm -rf .wrangler/state/v3/d1/miniflare-D1DatabaseObject && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0001_init.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0002_post_likes.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0003_user_roles.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0004_security.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0005_security_audit_logs.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0006_admin_password_reset.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0007_attachments.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0008_comment_attachments.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0009_post_moderation_and_settings.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0010_user_deletions.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0011_messages.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0012_storage_limit_settings.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0013_discussion_areas.sql && CI=1 npx wrangler d1 execute forum_db --local --config wrangler.json -y --file migrations/0014_posts_comments_soft_delete.sql && CI=1 npx wrangler dev --port 8788 --ip 127.0.0.1 --show-interactive-dev-session=false --var EMAIL_PROVIDER:disabled --var E2E:1 --var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA --config wrangler.json",
		url: "http://127.0.0.1:8788",
		reuseExistingServer: false,
		timeout: 600000,
	},
});
