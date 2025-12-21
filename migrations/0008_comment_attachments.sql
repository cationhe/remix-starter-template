CREATE TABLE IF NOT EXISTS comment_attachments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	comment_id INTEGER NOT NULL,
	post_id INTEGER NOT NULL,
	uploader_id INTEGER NOT NULL,
	r2_key TEXT NOT NULL,
	filename TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	FOREIGN KEY(comment_id) REFERENCES comments(id),
	FOREIGN KEY(post_id) REFERENCES posts(id),
	FOREIGN KEY(uploader_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_comment_attachments_comment_created_at
	ON comment_attachments (comment_id, created_at);

CREATE INDEX IF NOT EXISTS idx_comment_attachments_post_created_at
	ON comment_attachments (post_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_attachments_r2_key
	ON comment_attachments (r2_key);

CREATE TABLE IF NOT EXISTS comment_attachment_uploads (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	post_id INTEGER NOT NULL,
	uploader_id INTEGER NOT NULL,
	comment_id INTEGER,
	r2_key TEXT NOT NULL,
	upload_id TEXT NOT NULL,
	filename TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	is_complete INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	FOREIGN KEY(post_id) REFERENCES posts(id),
	FOREIGN KEY(comment_id) REFERENCES comments(id),
	FOREIGN KEY(uploader_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_comment_attachment_uploads_post_expires_at
	ON comment_attachment_uploads (post_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_comment_attachment_uploads_uploader_expires_at
	ON comment_attachment_uploads (uploader_id, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_attachment_uploads_r2_key
	ON comment_attachment_uploads (r2_key);

CREATE TABLE IF NOT EXISTS comment_attachment_upload_parts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	upload_record_id INTEGER NOT NULL,
	part_number INTEGER NOT NULL,
	etag TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	FOREIGN KEY(upload_record_id) REFERENCES comment_attachment_uploads(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_attachment_upload_parts_unique
	ON comment_attachment_upload_parts (upload_record_id, part_number);
