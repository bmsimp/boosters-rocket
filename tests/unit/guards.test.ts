import { describe, it, expect, vi, beforeEach } from "vitest";

const ident = vi.hoisted(() => ({ staff: null as unknown, parent: null as unknown, perms: new Set<string>(), admin: false }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => ident.staff,
  getParentIdentity: async () => ident.parent,
  getParentState: async () => (ident.parent ? { status: "ok", identity: ident.parent } : { status: "none" }),
  hasStaffSession: async () => Boolean(ident.staff),
  hasParentSession: async () => Boolean(ident.parent),
}));
vi.mock("@/lib/permissions/effective", () => ({
  effectivePermissions: async () => ({ isAdmin: ident.admin, permissions: ident.perms }),
  can: (e: { isAdmin: boolean; permissions: Set<string> }, p: string) => e.isAdmin || e.permissions.has(p),
}));
vi.mock("@/lib/request", () => ({ requestIp: async () => "203.0.113.1" }));
vi.mock("@/lib/audit/log", () => ({ writeAudit: vi.fn(async () => undefined) }));

import { staffAction, parentAction, parentSessionAction, guardOf, AccessDenied } from "@/lib/guards";

const STAFF = { door: "staff", staffUserId: "s1", name: "Pat", email: "pat@club.org" };
const PARENT = { door: "parent", parentId: "p1", sessionId: "s1", guardianId: "g1", familyQboId: "123", name: "Ana", email: "ana@example.com", families: [{ guardianId: "g1", familyQboId: "123" }] };

beforeEach(() => { ident.staff = null; ident.parent = null; ident.perms = new Set(); ident.admin = false; });

describe("staffAction", () => {
  const act = staffAction("Settings.Club.ReadWrite", async (ctx, x: number) => `${ctx.staffUserId}:${x}`);

  it("runs with the permission", async () => {
    ident.staff = STAFF; ident.perms = new Set(["Settings.Club.ReadWrite"]);
    await expect(act(2)).resolves.toBe("s1:2");
  });
  it("refuses without the permission", async () => {
    ident.staff = STAFF;
    await expect(act(2)).rejects.toBeInstanceOf(AccessDenied);
  });
  it("refuses a parent session even if one exists", async () => {
    ident.parent = PARENT;
    await expect(act(2)).rejects.toBeInstanceOf(AccessDenied);
  });
  it("records its declared permission", () => {
    expect(guardOf(act)).toEqual({ door: "staff", permission: "Settings.Club.ReadWrite" });
  });
});

describe("parentAction", () => {
  const act = parentAction(async (ctx) => ctx.familyQboId);

  it("runs for a parent and scopes to their family", async () => {
    ident.parent = PARENT;
    await expect(act()).resolves.toBe("123");
  });
  it("refuses a staff session, even an admin's", async () => {
    ident.staff = STAFF; ident.admin = true;
    await expect(act()).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe("parentSessionAction", () => {
  const act = parentSessionAction(async (ctx) => ctx.parentId);
  it("runs for a signed-in parent and is registered for the parent door", async () => {
    ident.parent = PARENT;
    await expect(act()).resolves.toBe("p1");
    expect(guardOf(act)).toEqual({ door: "parent" });
  });
  it("refuses without a parent session", async () => {
    await expect(act()).rejects.toBeInstanceOf(AccessDenied);
  });
});
