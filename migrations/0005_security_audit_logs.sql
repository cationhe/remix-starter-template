CREATE TABLE IF NOT EXISTS security_audit_logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	event_type TEXT NOT NULL,
	ip TEXT,
	user_agent TEXT,
	metadata_json TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_audit_logs_user_created_at
	ON security_audit_logs (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_security_audit_logs_event_created_at
	ON security_audit_logs (event_type, created_at);

