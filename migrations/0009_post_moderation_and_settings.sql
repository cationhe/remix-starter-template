ALTER TABLE posts ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN banned_at INTEGER;
ALTER TABLE posts ADD COLUMN banned_by INTEGER;
ALTER TABLE posts ADD COLUMN banned_reason TEXT;

ALTER TABLE posts ADD COLUMN pinned_until_ms INTEGER;
ALTER TABLE posts ADD COLUMN pinned_at INTEGER;
ALTER TABLE posts ADD COLUMN pinned_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_posts_is_banned ON posts(is_banned);
CREATE INDEX IF NOT EXISTS idx_posts_pinned_until_ms ON posts(pinned_until_ms);

CREATE TABLE IF NOT EXISTS app_settings (
	key TEXT PRIMARY KEY,
	value_json TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO app_settings (key, value_json, updated_at)
VALUES ('registration_paused', 'false', strftime('%s','now') * 1000);
