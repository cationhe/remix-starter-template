CREATE TABLE IF NOT EXISTS daily_user_activity (
	user_id INTEGER NOT NULL,
	day_key INTEGER NOT NULL,
	post_count INTEGER NOT NULL DEFAULT 0,
	comment_count INTEGER NOT NULL DEFAULT 0,
	last_post_at INTEGER,
	last_comment_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, day_key)
);

CREATE INDEX IF NOT EXISTS idx_daily_user_activity_day_key_user
	ON daily_user_activity (day_key, user_id);

CREATE TABLE IF NOT EXISTS user_daily_quota_overrides (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	post_limit INTEGER,
	comment_limit INTEGER,
	starts_at_ms INTEGER NOT NULL,
	ends_at_ms INTEGER NOT NULL,
	created_by INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	revoked_at INTEGER,
	revoked_by INTEGER,
	reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_daily_quota_overrides_user_active
	ON user_daily_quota_overrides (user_id, revoked_at, starts_at_ms, ends_at_ms, created_at);

CREATE INDEX IF NOT EXISTS idx_user_daily_quota_overrides_active_window
	ON user_daily_quota_overrides (revoked_at, starts_at_ms, ends_at_ms);
