import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { resetDb } from "../helpers/db";

describe("writeAudit", () => {
  beforeEach(resetDb);

  it("records who, what, which record, before/after, and IP", async () => {
    await writeAudit({
      actor: { door: "staff", id: "s1", label: "Pat (pat@club.org)" },
      action: "role.assign", permission: "Admin.Roles.ReadWrite",
      targetType: "staff_user", targetId: "s2", before: { roles: [] }, after: { roles: ["Treasurer"] }, ip: "203.0.113.9",
    });
    const [row] = await db.select().from(auditLog);
    expect(row).toMatchObject({
      door: "staff", actorId: "s1", action: "role.assign", targetId: "s2",
      before: { roles: [] }, after: { roles: ["Treasurer"] }, ip: "203.0.113.9",
    });
  });

  it("stores a malformed IP as null rather than failing the write", async () => {
    await writeAudit({ actor: { door: "system", id: null, label: null }, action: "x", ip: "not-an-ip" });
    const [row] = await db.select().from(auditLog);
    expect(row?.ip).toBeNull();
  });
});
