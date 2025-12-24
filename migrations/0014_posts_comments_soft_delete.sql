ALTER TABLE posts ADD COLUMN deleted_at INTEGER;
ALTER TABLE posts ADD COLUMN deleted_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_posts_deleted_at ON posts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_posts_author_deleted_at ON posts(author_id, deleted_at);

ALTER TABLE comments ADD COLUMN deleted_at INTEGER;
ALTER TABLE comments ADD COLUMN deleted_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_comments_deleted_at ON comments(deleted_at);
CREATE INDEX IF NOT EXISTS idx_comments_author_deleted_at ON comments(author_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_comments_post_deleted_at ON comments(post_id, deleted_at);

