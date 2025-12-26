INSERT INTO security_audit_logs (user_id, event_type, ip, user_agent, metadata_json, created_at)
VALUES (
	0,
	'rbac_policy_changed',
	NULL,
	'migration',
	'{"change":"grant_topadmin_discussion_area_reorder_and_pin_same_as_superadmin","scopes":["admin.discussion_areas.reorder","posts.pin"],"note":"topadmin 与 superadmin 在讨论区排序与置顶权限上保持一致"}',
	CAST(strftime('%s','now') AS INTEGER) * 1000
);
