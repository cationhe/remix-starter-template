ALTER TABLE daily_user_activity ADD COLUMN image_upload_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_user_activity ADD COLUMN last_image_upload_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_daily_user_activity_day_key_image
	ON daily_user_activity (day_key, image_upload_bytes, user_id);
