CREATE TABLE IF NOT EXISTS discussion_role_inheritance (
	role TEXT PRIMARY KEY,
	parent_role TEXT,
	updated_at INTEGER NOT NULL,
	updated_by INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discussion_area_role_permissions (
	area_id INTEGER NOT NULL,
	role TEXT NOT NULL,
	inherit INTEGER NOT NULL DEFAULT 1,
	can_view INTEGER,
	can_post INTEGER,
	can_comment INTEGER,
	can_download_attachments INTEGER,
	updated_at INTEGER NOT NULL,
	updated_by INTEGER NOT NULL,
	PRIMARY KEY (area_id, role),
	FOREIGN KEY(area_id) REFERENCES discussion_areas(id)
);

CREATE INDEX IF NOT EXISTS idx_discussion_area_role_permissions_role
	ON discussion_area_role_permissions (role, area_id);

CREATE INDEX IF NOT EXISTS idx_discussion_area_role_permissions_view
	ON discussion_area_role_permissions (role, can_view);

INSERT OR IGNORE INTO discussion_role_inheritance (role, parent_role, updated_at, updated_by)
VALUES
	('user', NULL, strftime('%s','now') * 1000, 0),
	('admin', 'user', strftime('%s','now') * 1000, 0),
	('superadmin', 'admin', strftime('%s','now') * 1000, 0),
	('topadmin', 'superadmin', strftime('%s','now') * 1000, 0);

INSERT OR IGNORE INTO discussion_area_role_permissions (area_id, role, inherit, can_view, can_post, can_comment, can_download_attachments, updated_at, updated_by)
SELECT
	a.id,
	'user',
	0,
	CASE WHEN a.is_hidden = 0 THEN 1 ELSE 0 END,
	CASE WHEN a.is_hidden = 0 THEN 1 ELSE 0 END,
	CASE WHEN a.is_hidden = 0 THEN 1 ELSE 0 END,
	CASE WHEN a.is_hidden = 0 THEN 1 ELSE 0 END,
	strftime('%s','now') * 1000,
	0
FROM discussion_areas a;

INSERT OR IGNORE INTO discussion_area_role_permissions (area_id, role, inherit, can_view, can_post, can_comment, can_download_attachments, updated_at, updated_by)
SELECT
	a.id,
	'admin',
	0,
	0,
	0,
	0,
	0,
	strftime('%s','now') * 1000,
	0
FROM discussion_areas a
WHERE a.is_hidden = 1;

INSERT OR IGNORE INTO discussion_area_role_permissions (area_id, role, inherit, can_view, can_post, can_comment, can_download_attachments, updated_at, updated_by)
SELECT
	a.id,
	'admin',
	1,
	NULL,
	NULL,
	NULL,
	NULL,
	strftime('%s','now') * 1000,
	0
FROM discussion_areas a
WHERE a.is_hidden = 0;

INSERT OR IGNORE INTO discussion_area_role_permissions (area_id, role, inherit, can_view, can_post, can_comment, can_download_attachments, updated_at, updated_by)
SELECT
	a.id,
	'superadmin',
	0,
	1,
	1,
	1,
	1,
	strftime('%s','now') * 1000,
	0
FROM discussion_areas a
WHERE a.is_hidden = 1;

INSERT OR IGNORE INTO discussion_area_role_permissions (area_id, role, inherit, can_view, can_post, can_comment, can_download_attachments, updated_at, updated_by)
SELECT
	a.id,
	'superadmin',
	1,
	NULL,
	NULL,
	NULL,
	NULL,
	strftime('%s','now') * 1000,
	0
FROM discussion_areas a
WHERE a.is_hidden = 0;

INSERT OR IGNORE INTO discussion_area_role_permissions (area_id, role, inherit, can_view, can_post, can_comment, can_download_attachments, updated_at, updated_by)
SELECT
	a.id,
	'topadmin',
	0,
	1,
	1,
	1,
	1,
	strftime('%s','now') * 1000,
	0
FROM discussion_areas a
WHERE a.is_hidden = 1;

INSERT OR IGNORE INTO discussion_area_role_permissions (area_id, role, inherit, can_view, can_post, can_comment, can_download_attachments, updated_at, updated_by)
SELECT
	a.id,
	'topadmin',
	1,
	NULL,
	NULL,
	NULL,
	NULL,
	strftime('%s','now') * 1000,
	0
FROM discussion_areas a
WHERE a.is_hidden = 0;
