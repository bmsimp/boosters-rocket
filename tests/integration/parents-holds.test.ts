import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { auditLog, guardian, heldAddress, parent, parentAuthSession, parentAuthUser } from "@/lib/db/schema";
import { runReconcile } from "@/lib/parents/reconcile";
import { decideHold, reverseHold } from "@/lib/parents/holds";
import { heldReview } from "@/lib/parents/directory";
import { resetDb, seedParentSession } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";

const staff = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000002", label: "reg@club.org" }, ip: "203.0.113.9", permission: "Parents.ReadWrite" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const TWO = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")];
const SHOWN = ["10", "20"];
const openFamilies = async () => (await db.select().from(guardian)).filter((g) => g.status !== "disabled").map((g) => g.familyQboId).sort();

describe("deciding a held address", () => {
  beforeEach(async () => { await resetDb(); await seedShape(); await seedParentSettings(SIGNINS_ON); await seedCache(TWO); await runReconcile({ cause: "test" }); });

  it("Same person gives the one person every listed family, in the same step, and is audited with the note", async () => {
    expect(await decideHold("ana@example.com", "same_person", SHOWN, "Called Ana; she is in both.", staff)).toEqual({ ok: true });
    expect(await openFamilies()).toEqual(["10", "20"]);
    expect(await db.select().from(parent)).toHaveLength(1);
    const [h] = await db.select().from(heldAddress);
    expect(h).toMatchObject({ approvedFamilyQboIds: ["10", "20"], rejectedFamilyQboIds: [], note: "Called Ana; she is in both.", decidedBy: staff.actor.id });
    const [row] = await audits("parent.hold.decided");
    expect(row).toMatchObject({ door: "staff", permission: "Parents.ReadWrite", targetType: "held_address", targetId: "ana@example.com", ip: "203.0.113.9" });
    expect(row!.after).toEqual({ decision: "same_person", familyQboIds: ["10", "20"], note: "Called Ana; she is in both." });
  });

  it("Not the same person keeps it held and takes it off the waiting list", async () => {
    expect(await decideHold("ana@example.com", "not_same", SHOWN, "Copied by mistake.", staff)).toEqual({ ok: true });
    expect(await openFamilies()).toEqual([]);
    const r = await heldReview();
    expect(r.waiting).toEqual([]);
    expect(r.decided).toEqual([expect.objectContaining({ email: "ana@example.com", approved: [], rejected: ["Rivera Family", "Chen Family"], note: "Copied by mistake." })]);
  });

  it("needs a note, and refuses an address that isn't held", async () => {
    expect(await decideHold("ana@example.com", "same_person", SHOWN, "   ", staff)).toEqual({ ok: false, errors: ["Add a short note saying how you know."] });
    expect(await decideHold("ana@example.com", "same_person", SHOWN, "x".repeat(501), staff)).toEqual({ ok: false, errors: ["Keep the note to 500 characters."] });
    expect(await decideHold("nobody@example.com", "same_person", SHOWN, "note", staff)).toEqual({ ok: false, errors: ["That address isn't held any more. Reload the page."] });
    expect(await audits("parent.hold.decided")).toEqual([]);
  });

  it("holds only the new family when an approved address appears under a third, and lists it as waiting again", async () => {
    await decideHold("ana@example.com", "same_person", SHOWN, "Both hers.", staff);
    await seedCache([...TWO, fam("30", "Third Family"), par("31", "Ana Rivera", "30", "ana@example.com")]);
    await runReconcile({ cause: "test" });
    expect(await openFamilies()).toEqual(["10", "20"]);
    expect((await heldReview()).waiting.map((w) => w.families.filter((f) => f.held).map((f) => f.qboId))).toEqual([["30"]]);
  });

  it("reversing a decision holds the address again and ends the access it gave", async () => {
    await decideHold("ana@example.com", "same_person", SHOWN, "Both hers.", staff);
    const [u] = await db.select().from(parentAuthUser);
    await seedParentSession(u!.id, { familyQboId: "10" });
    expect(await reverseHold("ana@example.com", "She says the Chen record is wrong.", staff)).toEqual({ ok: true });
    expect(await openFamilies()).toEqual([]);
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await heldReview()).waiting).toHaveLength(1);
    expect((await audits("parent.hold.decided")).at(-1)!.after).toMatchObject({ decision: "reversed" });
  });

  it("Not the same person, then a third family appears: waiting again, all three held", async () => {
    await decideHold("ana@example.com", "not_same", SHOWN, "Copied by mistake.", staff);
    await seedCache([...TWO, fam("30", "Third Family"), par("31", "Ana Rivera", "30", "ana@example.com")]);
    await runReconcile({ cause: "test" });
    expect(await openFamilies()).toEqual([]);
    const w = (await heldReview()).waiting;
    expect(w.map((x) => x.families.filter((f) => f.held).map((f) => f.qboId))).toEqual([["10", "20", "30"]]);
  });

  it("refuses a reversal when there is no decision", async () => {
    expect(await reverseHold("ana@example.com", "note", staff)).toEqual({ ok: false, errors: ["There is no decision on that address to reverse."] });
    expect(await audits("parent.hold.decided")).toEqual([]);
  });

  describe("families that changed since the page loaded", () => {
    const CHANGED = { ok: false, errors: ["That address has changed since this page loaded. Reload the page and look again."] };
    const untouched = async () => {
      const [h] = await db.select().from(heldAddress);
      expect(h).toMatchObject({ approvedFamilyQboIds: [], rejectedFamilyQboIds: [], note: null });
      expect(await openFamilies()).toEqual([]);
      expect(await audits("parent.hold.decided")).toEqual([]);
    };
    it.each(["same_person", "not_same"] as const)("refuses %s when a family was added, and changes nothing", async (decision) => {
      await seedCache([...TWO, fam("30", "Third Family"), par("31", "Ana Rivera", "30", "ana@example.com")]);
      await runReconcile({ cause: "test" });
      expect(await decideHold("ana@example.com", decision, SHOWN, "note", staff)).toEqual(CHANGED);
      await untouched();
    });
    it.each(["same_person", "not_same"] as const)("refuses %s when a family was removed, and changes nothing", async (decision) => {
      expect(await decideHold("ana@example.com", decision, ["10", "20", "30"], "note", staff)).toEqual(CHANGED);
      await untouched();
    });
    it("accepts the same families in another order, with duplicates", async () => {
      expect(await decideHold("ana@example.com", "same_person", ["20", "10", "20"], "note", staff)).toEqual({ ok: true });
      expect(await openFamilies()).toEqual(["10", "20"]);
    });
  });
});
