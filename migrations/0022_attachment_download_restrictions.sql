ALTER TABLE attachments ADD COLUMN is_downloadable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE comment_attachments ADD COLUMN is_downloadable INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_attachments_post_downloadable
	ON attachments (post_id, is_downloadable);

CREATE INDEX IF NOT EXISTS idx_comment_attachments_post_downloadable
	ON comment_attachments (post_id, is_downloadable);

UPDATE attachments
SET is_downloadable = 0
WHERE post_id IN (SELECT id FROM posts WHERE is_banned = 1 AND deleted_at IS NULL);

UPDATE comment_attachments
SET is_downloadable = 0
WHERE post_id IN (SELECT id FROM posts WHERE is_banned = 1 AND deleted_at IS NULL);
