INSERT OR IGNORE INTO app_settings (key, value_json, updated_at)
VALUES ('total_storage_limit_bytes', '5368709120', strftime('%s','now') * 1000);

