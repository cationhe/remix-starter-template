ALTER TABLE posts ADD COLUMN updated_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_posts_updated_at ON posts(updated_at);
CREATE INDEX IF NOT EXISTS idx_posts_updated_by ON posts(updated_by);

CREATE TABLE IF NOT EXISTS post_edits (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	post_id INTEGER NOT NULL,
	editor_id INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	old_title TEXT NOT NULL,
	old_content TEXT NOT NULL,
	old_area_id INTEGER NOT NULL,
	new_title TEXT NOT NULL,
	new_content TEXT NOT NULL,
	new_area_id INTEGER NOT NULL,
	FOREIGN KEY(post_id) REFERENCES posts(id),
	FOREIGN KEY(editor_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_post_edits_post_created_at
	ON post_edits(post_id, created_at);

CREATE INDEX IF NOT EXISTS idx_post_edits_editor_created_at
	ON post_edits(editor_id, created_at);
