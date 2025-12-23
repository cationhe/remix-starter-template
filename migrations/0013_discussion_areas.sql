CREATE TABLE IF NOT EXISTS discussion_areas (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	sort_order INTEGER NOT NULL,
	is_hidden INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discussion_areas_name_unique
	ON discussion_areas (name);

CREATE INDEX IF NOT EXISTS idx_discussion_areas_sort_order
	ON discussion_areas (sort_order);

INSERT OR IGNORE INTO discussion_areas (id, name, sort_order, is_hidden, created_at, updated_at)
VALUES (1, '站点公告区', 1, 0, strftime('%s','now') * 1000, strftime('%s','now') * 1000);

ALTER TABLE posts ADD COLUMN area_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_posts_area_created_at
	ON posts (area_id, created_at);

CREATE INDEX IF NOT EXISTS idx_posts_area_pinned_until
	ON posts (area_id, pinned_until_ms);
