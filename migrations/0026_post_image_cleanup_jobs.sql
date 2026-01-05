CREATE TABLE IF NOT EXISTS post_image_cleanup_jobs (
	image_id INTEGER PRIMARY KEY,
	post_id INTEGER NOT NULL,
	uploader_id INTEGER NOT NULL,
	draft_id TEXT,
	r2_key TEXT NOT NULL,
	filename TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_retry_at INTEGER NOT NULL,
	last_error TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_post_image_cleanup_jobs_next_retry
	ON post_image_cleanup_jobs (next_retry_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_post_image_cleanup_jobs_post
	ON post_image_cleanup_jobs (post_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_post_image_cleanup_jobs_uploader
	ON post_image_cleanup_jobs (uploader_id, updated_at);
