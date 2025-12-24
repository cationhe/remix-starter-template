import { test, expect } from "@playwright/test";
import { canSendMessage, getAllowedRecipientRoles } from "../../app/lib/messages.server";
import type { UserRole } from "../../app/lib/auth.server";

test("getAllowedRecipientRoles 返回正确的收件人角色集合", () => {
	expect(getAllowedRecipientRoles("superadmin")).toEqual(["admin", "user"]);
	expect(getAllowedRecipientRoles("topadmin")).toEqual(["admin", "user"]);
	expect(getAllowedRecipientRoles("admin")).toEqual(["superadmin", "topadmin", "user"]);
	expect(getAllowedRecipientRoles("user")).toEqual(["superadmin", "topadmin", "admin"]);
});

test("canSendMessage 严格符合超级管理员/管理员/普通用户规则", () => {
	const roles: UserRole[] = ["topadmin", "superadmin", "admin", "user"];
	const expected: Record<UserRole, Record<UserRole, boolean>> = {
		topadmin: {
			topadmin: false,
			superadmin: false,
			admin: true,
			user: true,
		},
		superadmin: {
			topadmin: false,
			superadmin: false,
			admin: true,
			user: true,
		},
		admin: {
			topadmin: true,
			superadmin: true,
			admin: false,
			user: true,
		},
		user: {
			topadmin: true,
			superadmin: true,
			admin: true,
			user: false,
		},
	};

	for (const sender of roles) {
		for (const recipient of roles) {
			expect(canSendMessage(sender, recipient)).toBe(expected[sender][recipient]);
		}
	}
});
