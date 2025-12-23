import { test, expect } from "@playwright/test";
import { canSendMessage, getAllowedRecipientRoles } from "../../app/lib/messages.server";
import type { UserRole } from "../../app/lib/auth.server";

test("getAllowedRecipientRoles 返回正确的收件人角色集合", () => {
	expect(getAllowedRecipientRoles("superadmin")).toEqual(["admin", "user"]);
	expect(getAllowedRecipientRoles("admin")).toEqual(["superadmin", "user"]);
	expect(getAllowedRecipientRoles("user")).toEqual(["superadmin", "admin"]);
});

test("canSendMessage 严格符合超级管理员/管理员/普通用户规则", () => {
	const roles: UserRole[] = ["superadmin", "admin", "user"];
	const expected: Record<UserRole, Record<UserRole, boolean>> = {
		superadmin: {
			superadmin: false,
			admin: true,
			user: true,
		},
		admin: {
			superadmin: true,
			admin: false,
			user: true,
		},
		user: {
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

