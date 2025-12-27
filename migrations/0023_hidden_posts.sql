ALTER TABLE posts ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN hidden_at INTEGER;
ALTER TABLE posts ADD COLUMN hidden_by INTEGER;
ALTER TABLE posts ADD COLUMN invited_users TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_posts_is_hidden
	ON posts (is_hidden);

CREATE TABLE IF NOT EXISTS hidden_post_invites (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	post_id INTEGER NOT NULL,
	invited_user_id INTEGER NOT NULL,
	invited_by INTEGER NOT NULL,
	invited_at INTEGER NOT NULL,
	accepted_at INTEGER,
	revoked_at INTEGER,
	revoked_by INTEGER,
	FOREIGN KEY(post_id) REFERENCES posts(id),
	FOREIGN KEY(invited_user_id) REFERENCES users(id),
	FOREIGN KEY(invited_by) REFERENCES users(id),
	FOREIGN KEY(revoked_by) REFERENCES users(id),
	UNIQUE(post_id, invited_user_id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_post_invites_user_post
	ON hidden_post_invites (invited_user_id, post_id);

CREATE INDEX IF NOT EXISTS idx_hidden_post_invites_post
	ON hidden_post_invites (post_id);

CREATE TABLE IF NOT EXISTS hidden_post_access_tokens (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	post_id INTEGER NOT NULL,
	user_id INTEGER NOT NULL,
	token_hash TEXT NOT NULL,
	issued_by INTEGER NOT NULL,
	issued_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER,
	FOREIGN KEY(post_id) REFERENCES posts(id),
	FOREIGN KEY(user_id) REFERENCES users(id),
	FOREIGN KEY(issued_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_post_access_tokens_hash
	ON hidden_post_access_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_hidden_post_access_tokens_post_user
	ON hidden_post_access_tokens (post_id, user_id);

ALTER TABLE messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN pinned_at INTEGER;
ALTER TABLE messages ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_messages_recipient_pinned_created_at
	ON messages (recipient_id, is_pinned, pinned_at, created_at);

