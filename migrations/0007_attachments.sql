CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  uploader_id INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(post_id) REFERENCES posts(id),
  FOREIGN KEY(uploader_id) REFERENCES users(id)
);
CREATE INDEX idx_attachments_post ON attachments(post_id);
CREATE INDEX idx_attachments_uploader ON attachments(uploader_id);
CREATE INDEX idx_attachments_created ON attachments(created_at);

CREATE TABLE attachment_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  uploader_id INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  upload_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(post_id) REFERENCES posts(id),
  FOREIGN KEY(uploader_id) REFERENCES users(id)
);
CREATE INDEX idx_attachment_uploads_post ON attachment_uploads(post_id);
CREATE INDEX idx_attachment_uploads_uploader ON attachment_uploads(uploader_id);
CREATE INDEX idx_attachment_uploads_expires ON attachment_uploads(expires_at);

CREATE TABLE attachment_upload_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_record_id INTEGER NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(upload_record_id, part_number),
  FOREIGN KEY(upload_record_id) REFERENCES attachment_uploads(id)
);
CREATE INDEX idx_attachment_upload_parts_upload ON attachment_upload_parts(upload_record_id);
