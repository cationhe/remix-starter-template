CREATE TABLE password_resets (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	expires_at INTEGER NOT NULL,
	used_at INTEGER,
	created_at INTEGER NOT NULL,
	requested_ip TEXT,
	FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX idx_password_resets_user ON password_resets(user_id);
CREATE INDEX idx_password_resets_expires ON password_resets(expires_at);
CREATE INDEX idx_password_resets_used ON password_resets(used_at);

CREATE TABLE auth_rate_limits (
	key TEXT PRIMARY KEY,
	count INTEGER NOT NULL,
	window_started_at INTEGER NOT NULL,
	blocked_until INTEGER,
	updated_at INTEGER NOT NULL
);

CREATE INDEX idx_auth_rate_limits_blocked_until ON auth_rate_limits(blocked_until);
CREATE INDEX idx_auth_rate_limits_updated_at ON auth_rate_limits(updated_at);

