ALTER TABLE comments ADD COLUMN updated_at INTEGER;
ALTER TABLE comments ADD COLUMN updated_by INTEGER;

ALTER TABLE comments ADD COLUMN is_shielded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN shielded_at INTEGER;
ALTER TABLE comments ADD COLUMN shielded_by INTEGER;
ALTER TABLE comments ADD COLUMN shield_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_comments_updated_at ON comments(updated_at);
CREATE INDEX IF NOT EXISTS idx_comments_is_shielded ON comments(is_shielded);
CREATE INDEX IF NOT EXISTS idx_comments_shielded_at ON comments(shielded_at);
CREATE INDEX IF NOT EXISTS idx_comments_post_shielded_at ON comments(post_id, is_shielded, shielded_at);

CREATE TABLE IF NOT EXISTS comment_shields (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	comment_id INTEGER NOT NULL,
	post_id INTEGER NOT NULL,
	comment_author_id INTEGER NOT NULL,
	operator_id INTEGER NOT NULL,
	reason TEXT NOT NULL,
	content_snapshot TEXT NOT NULL,
	post_title_snapshot TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comment_shields_created_at ON comment_shields(created_at);
CREATE INDEX IF NOT EXISTS idx_comment_shields_comment_created_at ON comment_shields(comment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_shields_post_created_at ON comment_shields(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_shields_author_created_at ON comment_shields(comment_author_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_shields_operator_created_at ON comment_shields(operator_id, created_at);
