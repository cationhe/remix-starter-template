ALTER TABLE users ADD COLUMN display_name_changed_at INTEGER;

CREATE TABLE IF NOT EXISTS nickname_change_requests (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	current_display_name TEXT NOT NULL,
	desired_display_name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	created_at INTEGER NOT NULL,
	reviewed_at INTEGER,
	reviewed_by INTEGER,
	review_note TEXT,
	FOREIGN KEY(user_id) REFERENCES users(id),
	FOREIGN KEY(reviewed_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_nickname_change_requests_user_id_created_at ON nickname_change_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_nickname_change_requests_status_created_at ON nickname_change_requests(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nickname_change_requests_user_pending ON nickname_change_requests(user_id) WHERE status = 'pending';
