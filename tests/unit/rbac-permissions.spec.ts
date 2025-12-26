import { test, expect } from "@playwright/test";
import { isAdmin, isSuperadmin } from "../../app/lib/auth.server";
import type { AuthUser, UserRole } from "../../app/lib/auth.server";

function makeUser(role: UserRole): AuthUser {
	return {
		id: 1,
		email: "test@example.com",
		displayName: "test",
		createdAt: 0,
		role,
		isBanned: false,
		bannedAt: null,
		mustChangePassword: false,
		tempPasswordExpiresAt: null,
	};
}

test("isSuperadmin 对 superadmin/topadmin 返回 true", () => {
	expect(isSuperadmin(makeUser("superadmin"))).toBe(true);
	expect(isSuperadmin(makeUser("topadmin"))).toBe(true);
	expect(isSuperadmin(makeUser("admin"))).toBe(false);
	expect(isSuperadmin(makeUser("user"))).toBe(false);
});

test("isAdmin 对 admin/superadmin/topadmin 返回 true", () => {
	expect(isAdmin(makeUser("admin"))).toBe(true);
	expect(isAdmin(makeUser("superadmin"))).toBe(true);
	expect(isAdmin(makeUser("topadmin"))).toBe(true);
	expect(isAdmin(makeUser("user"))).toBe(false);
});
