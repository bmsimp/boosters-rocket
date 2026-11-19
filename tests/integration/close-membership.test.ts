import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parentAuthSession, parentDevice } from "@/lib/db/schema";
import { closeMembership } from "@/lib/parents/membership";
import { resetDb, seedGuardianInFamily, seedParent, seedParentSession } from "../helpers/db";
import { credentialRows, linkRows, mintLink, seedDevice, seedPassword } from "../helpers/signin-links";

/**
 * closeMembership() (src/lib/parents/membership.ts) asked without the reconcile's `stillOpenElsewhere`: it asks the
 * database, in the caller's transaction, whether the person has another open row. With one, only the closed family's
 * sessions end, by the family record the row and the session name (`family_id`); with none left, every session of
 * theirs ends, the chooser's (no family yet) included. Another person's sessions are never touched, in the same family
 * or not. Each row is in a family record of its own QuickBooks id (seedGuardianInFamily()), as the gate needs.
 */
const ROSTER = { door: "system" as const, id: null, label: "roster" };
/** The family each of a person's sessions chose, named by the QuickBooks id of the rows in that family record. */
const sessionsOf = async (authUserId: string) => {
  const names = new Map((await db.select({ id: guardian.familyId, qboId: guardian.familyQboId }).from(guardian)).map((g) => [String(g.id), g.qboId]));
  return (await db.select({ family: parentAuthSession.familyId }).from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId)))
    .map((s) => (s.family === null ? "(none yet)" : names.get(String(s.family)) ?? "(another family)")).sort();
};
const close = (row: typeof guardian.$inferSelect) => db.transaction(async (tx) => {
  const [locked] = await tx.select().from(guardian).where(eq(guardian.id, row.id)).for("update");
  return closeMembership(tx, locked!, { reason: "removed", actor: ROSTER });
});

describe("closeMembership() with no stillOpenElsewhere", () => {
  beforeEach(async () => { await resetDb(); });

  it("ends only that family's sessions while another row is open, and every session once the last open row closes", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    const other = await seedParent({ name: "Ben", email: "ben@example.com" });
    const f1 = await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1" }), f2 = await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F2" });
    await seedGuardianInFamily({ parentId: other.id, familyQboId: "F1" });
    for (const familyQboId of ["F1", "F2", null]) await seedParentSession(ana.authUserId, { familyQboId });
    await seedParentSession(other.authUserId, { familyQboId: "F1" });

    expect(await close(f1)).toEqual({ wasOpen: true, sessionsEnded: 1 });
    expect(await sessionsOf(ana.authUserId)).toEqual(["(none yet)", "F2"]);

    expect(await close(f2)).toEqual({ wasOpen: true, sessionsEnded: 2 });
    expect(await sessionsOf(ana.authUserId)).toEqual([]);
    // Ben's open row in F1 and his session there are his own: untouched.
    expect(await sessionsOf(other.authUserId)).toEqual(["F1"]);

    const ended = await db.select().from(auditLog).where(and(eq(auditLog.action, "parent.access.ended")));
    expect(ended.find((r) => r.targetId === f1.id)!.after).toMatchObject({ parentId: ana.id, familyQboId: "F1", reason: "removed", sessionsEnded: 1 });
    expect(ended.find((r) => r.targetId === f2.id)!.after).toMatchObject({ parentId: ana.id, familyQboId: "F2", reason: "removed", sessionsEnded: 2 });
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana.id))).map((g) => [g.status, g.disabledReason, g.statusBeforeDisable]))
      .toEqual([["disabled", "removed", "active"], ["disabled", "removed", "active"]]);
  });

  it("counts a row already closed as no open row: closing the person's other row ends every session", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1", status: "disabled", disabledReason: "family_inactive", statusBeforeDisable: "active" });
    const f2 = await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F2" });
    await seedParentSession(ana.authUserId, { familyQboId: "F2" });
    await seedParentSession(ana.authUserId, { familyQboId: null });
    expect(await close(f2)).toEqual({ wasOpen: true, sessionsEnded: 2 });
    expect(await sessionsOf(ana.authUserId)).toEqual([]);
  });

  it("keeps the person's unused links and devices while another row is open, and deletes them, keeping the password, once the last open row closes", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    const f1 = await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1" }), f2 = await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F2" });
    await seedPassword(ana.authUserId, "a password long enough to keep");
    await mintLink(ana.id, "reset");
    await seedDevice(ana.id);
    const devices = () => db.select().from(parentDevice).where(eq(parentDevice.parentId, ana.id));

    await close(f1);
    expect(await linkRows(ana.id)).toHaveLength(1);
    expect(await devices()).toHaveLength(1);

    // The lead's choice 10 of the sign-in release: the last open row closed ends all of the person's sign-in but the password.
    await close(f2);
    expect(await linkRows(ana.id)).toEqual([]);
    expect(await devices()).toEqual([]);
    expect(await credentialRows(ana.authUserId)).toHaveLength(1);
    const ended = await db.select().from(auditLog).where(eq(auditLog.action, "parent.access.ended"));
    expect(ended.find((r) => r.targetId === f1.id)!.after).not.toHaveProperty("linksDeleted");
    expect(ended.find((r) => r.targetId === f2.id)!.after).toMatchObject({ linksDeleted: 1, devicesForgotten: 1 });
  });
});
