CREATE TABLE IF NOT EXISTS post_images (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	post_id INTEGER,
	uploader_id INTEGER NOT NULL,
	draft_id TEXT,
	r2_key TEXT NOT NULL,
	filename TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_post_images_post_id_created
	ON post_images (post_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_post_images_uploader_id_created
	ON post_images (uploader_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_post_images_draft_id_created
	ON post_images (draft_id, created_at, id);

CREATE TABLE IF NOT EXISTS post_image_uploads (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	post_id INTEGER,
	uploader_id INTEGER NOT NULL,
	draft_id TEXT,
	r2_key TEXT NOT NULL,
	upload_id TEXT NOT NULL,
	filename TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_post_image_uploads_post_active
	ON post_image_uploads (post_id, expires_at, created_at, id);

CREATE INDEX IF NOT EXISTS idx_post_image_uploads_uploader_active
	ON post_image_uploads (uploader_id, expires_at, created_at, id);

CREATE INDEX IF NOT EXISTS idx_post_image_uploads_draft_active
	ON post_image_uploads (draft_id, expires_at, created_at, id);

CREATE TABLE IF NOT EXISTS post_image_upload_parts (
	upload_record_id INTEGER NOT NULL,
	part_number INTEGER NOT NULL,
	etag TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (upload_record_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_post_image_upload_parts_upload
	ON post_image_upload_parts (upload_record_id, part_number);
