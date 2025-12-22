ALTER TABLE users ADD COLUMN deleted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

CREATE TABLE IF NOT EXISTS user_deletion_backups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	target_user_id INTEGER NOT NULL,
	operator_user_id INTEGER NOT NULL,
	mode TEXT NOT NULL,
	backup_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_deletion_backups_target_user_id ON user_deletion_backups(target_user_id);
CREATE INDEX IF NOT EXISTS idx_user_deletion_backups_operator_user_id ON user_deletion_backups(operator_user_id);
CREATE INDEX IF NOT EXISTS idx_user_deletion_backups_created_at ON user_deletion_backups(created_at);
