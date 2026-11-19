import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, requirement, signatureRequest } from "@/lib/db/schema";
import { clubToday } from "@/lib/settings/club";
import { addDays, formsToChase, shiftsToFill } from "@/lib/staff-home/today";
import StaffHome from "@/app/staff/(app)/page";
import { resetDb, seedStaff } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedTwoFamilies } from "../helpers/parent";
import { seedQueued, staffWith } from "../helpers/roster-writes";
import { seedEvent, seedSignup } from "../helpers/volunteer";

// The staff home's "Today" box (src/app/staff/(app)/today.tsx): one line per kind of thing waiting, each read only for
// staff who hold its permission, as a count in words. The seeded families' own markers never appear: only counts.
const HOUR = 3_600_000;
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const todayItems = (html: string) => [...html.matchAll(/data-today="([a-z]+)"/g)].map((m) => m[1]);
const home = async () => renderPage(StaffHome);

let families: Awaited<ReturnType<typeof seedTwoFamilies>>;
beforeEach(async () => {
  await resetDb();
  families = await seedTwoFamilies();
  // Two changes waiting to reach QuickBooks, and one stuck.
  await seedQueued({ op: "deactivate", role: "parent", qboId: "21", syncToken: "0" }, { familyQboId: FAMILY_A.family.qboId });
  await seedQueued({ op: "deactivate", role: "parent", qboId: "22", syncToken: "0" }, { familyQboId: FAMILY_B.family.qboId });
  await seedQueued({ op: "deactivate", role: "parent", qboId: "23", syncToken: "0" }, { state: "stuck", tries: 8 });
  // Forms: Travel consent (asked of each family, neither has signed) is due in three days; A's student's signed form has
  // waited two hours for Documenso to seal it; A's complete form has waited two hours for its signed copy to be kept.
  await db.update(requirement).set({ dueOn: addDays(await clubToday(), 3) }).where(eq(requirement.title, "Travel consent"));
  await db.update(signatureRequest).set({ allSignedAt: new Date(Date.now() - 2 * HOUR) }).where(eq(signatureRequest.id, families.a.forms!.ids.signed));
  await db.update(signatureRequest).set({ evidenceOwed: false }).where(eq(signatureRequest.state, "complete"));
  await db.update(signatureRequest).set({ evidenceOwed: true, completedAt: new Date(Date.now() - 2 * HOUR) }).where(eq(signatureRequest.id, families.a.forms!.ids.complete));
  // A shift in two days with 3 places, 1 taken; a cancelled one beside it and one in ten days, which don't count.
  const soon = await seedEvent({ name: "Concessions", inDays: 2, shifts: [{ startsAt: "10:00", endsAt: "12:00", places: 3 }, { startsAt: "13:00", endsAt: "15:00", places: 5, cancelled: true }] });
  await seedSignup({ shiftId: soon.shifts[0]!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: families.a.identity.parentId, guardianName: FAMILY_A.parent.name });
  await seedEvent({ name: "Later", inDays: 10, shifts: [{ startsAt: "10:00", endsAt: "12:00", places: 4 }] });
});

describe("the counts", () => {
  it("count forms waiting too long and shifts with places to fill, and nothing else", async () => {
    expect(await formsToChase()).toEqual({ sealingLate: 1, evidenceLate: 1, dueSoon: { forms: 1, unsigned: 2 } });
    expect(await shiftsToFill()).toEqual({ shifts: 1, places: 2 });
    // A form due further off than a week is not near; one past its due date still is.
    await db.update(requirement).set({ dueOn: addDays(await clubToday(), 8) }).where(eq(requirement.title, "Travel consent"));
    expect((await formsToChase()).dueSoon).toEqual({ forms: 0, unsigned: 0 });
    await db.update(requirement).set({ dueOn: addDays(await clubToday(), -2) }).where(eq(requirement.title, "Travel consent"));
    expect((await formsToChase()).dueSoon).toEqual({ forms: 1, unsigned: 2 });
    // A family that signs is no longer counted.
    await db.update(signatureRequest).set({ state: "complete", evidenceOwed: false, completedAt: new Date() }).where(eq(signatureRequest.id, families.a.forms!.ids.waiting));
    expect((await formsToChase()).dueSoon).toEqual({ forms: 1, unsigned: 1 });
  });

  it("add days to a calendar day across a month's end", () => {
    expect(addDays("2026-11-28", 7)).toBe("2026-12-05");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("the staff home", () => {
  it("shows each item only to staff who hold its permission, as a count in words with a link", async () => {
    const cases: [string[], string[], string[]][] = [
      // The held-address review is gone (stage 3 of the app-owned families spec): Parents has nothing waiting to count.
      [["Parents.ReadWrite"], [], []],
      [["Roster.Read"], ["stuck", "waiting"], ["1 change stuck on its way to QuickBooks", "2 changes waiting to reach QuickBooks", 'href="/staff/reconciliation"']],
      [["Forms.Signature.Read"], ["due", "sealing", "evidence"], ["2 forms still to sign, due within 7 days or already due",
        "1 form signed but not yet finished by Documenso", "1 signed form waiting for the signed copy to be kept", 'href="/staff/forms"']],
      [["Volunteer.Event.Read"], ["shifts"], ["2 places to fill on 1 shift in the next 7 days", 'href="/staff/volunteer"']],
    ];
    for (const [i, [permissions, items, words]] of cases.entries()) {
      asStaff(await staffWith(`one${i}@club.org`, permissions));
      const html = await home();
      expect(todayItems(html), permissions[0]).toEqual(items);
      for (const w of words) expect(w.startsWith("href") ? html : text(html), permissions[0]).toContain(w);
    }
  });

  it("says nothing needs doing, calmly, to staff who hold none of the permissions", async () => {
    asStaff(await staffWith("none@club.org", ["Settings.Club.Read"]));
    const html = await home();
    expect(todayItems(html)).toEqual([]);
    expect(text(html)).toContain("Today Nothing needs doing today.");
  });

  it("says nothing needs doing when nothing is waiting, even to an Admin", async () => {
    const admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
    asStaff(admin);
    expect(todayItems(await home())).toEqual(["stuck", "waiting", "due", "sealing", "evidence", "shifts"]);
    await resetDb();
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const quiet = await home();
    expect(todayItems(quiet)).toEqual([]);
    expect(text(quiet)).toContain("Nothing needs doing today.");
  });

  it("shows counts only, never a family's name or id, and is not audited", async () => {
    const before = (await db.select().from(auditLog)).length;
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const html = await home();
    for (const marker of [FAMILY_A.family.name, FAMILY_B.family.name, FAMILY_A.family.qboId, FAMILY_B.family.qboId, "Concessions", "Travel consent"]) {
      expect(html).not.toContain(marker);
    }
    expect((await db.select().from(auditLog)).length).toBe(before);
    // The rows the counts came from are untouched.
    expect((await db.select().from(signatureRequest).where(and(eq(signatureRequest.evidenceOwed, true), eq(signatureRequest.state, "complete")))).length).toBe(1);
  });
});
