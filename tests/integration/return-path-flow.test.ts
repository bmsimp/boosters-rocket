import { describe, it, expect, beforeEach } from "vitest";
import { asParent, asParentChoosing, asRefusedParent, pageOutcome, redirectOf, renderPage } from "../helpers/signed-in";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parentAuthSession } from "@/lib/db/schema";
import { parentLayoutCtx, requireParentPage } from "@/lib/guards";
import ParentSignIn from "@/app/sign-in/page";
import ChooseFamily from "@/app/choose-family/page";
import { chooseFamilyAction } from "@/app/choose-family/actions";
import { resetDb, seedGuardian, seedWorkingMail } from "../helpers/db";
import { seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * The page a parent asked for, carried from the page's own guard through the sign-in page and the family chooser
 * (src/lib/auth/return-path.ts has the rule; tests/unit/return-path.test.ts every way of breaking it). Here: each place
 * the value is read takes it from the browser and checks it again, and the chooser's action, given another family's
 * id, changes nothing.
 */
const HOSTILE: unknown[] = ["//evil.example", "/\\evil.example", "https://evil.example/", "/staff/roster", "/api/auth/parent/sign-out", "/setup", "/%2F%2Fevil.example", ["/display"], 7, new FormData()];
/** The app's family record a parent's session has chosen, or null. */
const sessionFamily = async (p: SeededParent) => (await db.select().from(parentAuthSession).where(eq(parentAuthSession.id, p.session.id)))[0]!.familyId;
const refusals = async () => (await db.select().from(auditLog)).filter((r) => r.action === "signin.refused");

describe("the page a parent asked for", () => {
  let a: SeededParent, b: SeededParent;
  beforeEach(async () => { await resetDb(); await seedWorkingMail(); ({ a, b } = await seedTwoFamilies()); });

  describe("the guard of a parent page", () => {
    it("sends a visitor with no session to sign in, with the page's own address", async () => {
      expect(await redirectOf(requireParentPage("/payments"))).toBe("/sign-in?next=%2Fpayments");
      expect(await redirectOf(requireParentPage("/forms/12?step=sign"))).toBe("/sign-in?next=%2Fforms%2F12%3Fstep%3Dsign");
    });

    it("sends a parent who has not chosen a family to choose, with the page's own address", async () => {
      asParentChoosing(a.identity);
      expect(await redirectOf(requireParentPage("/payments"))).toBe("/choose-family?next=%2Fpayments");
    });

    it("keeps working with no address, and lands on the home page", async () => {
      expect(await redirectOf(requireParentPage())).toBe("/sign-in");
      expect(await redirectOf(requireParentPage("/"))).toBe("/sign-in");
      asParentChoosing(a.identity);
      expect(await redirectOf(requireParentPage())).toBe("/choose-family");
    });

    it("tells a refused session nothing, whatever page was asked for", async () => {
      asRefusedParent();
      expect(await redirectOf(requireParentPage("/payments"))).toBe("/refused");
    });

    it("drops an address that is not a parent page, as a page might build one from what it was asked for", async () => {
      for (const id of ["../staff", "..%2Fstaff", "x/../../staff", "12#top", "12\\evil.example"]) {
        expect(await redirectOf(requireParentPage(`/forms/${id}`))).toBe("/sign-in");
      }
      for (const value of HOSTILE) expect(await redirectOf(requireParentPage(value as string))).toBe("/sign-in");
    });

    it("lets a signed-in parent through and returns the family from the session, whatever address is passed", async () => {
      asParent(a.identity);
      expect(await requireParentPage("/payments")).toMatchObject({ familyId: a.identity.familyId, parentId: a.identity.parentId });
      expect(await requireParentPage("//evil.example")).toMatchObject({ familyId: a.identity.familyId });
    });
  });

  describe("the parent layout's own check", () => {
    it("answers with the signed-in parent, and with nothing (and no redirect) for anyone else", async () => {
      expect(await parentLayoutCtx()).toBeNull();
      asParentChoosing(a.identity);
      expect(await parentLayoutCtx()).toBeNull();
      asRefusedParent();
      expect(await parentLayoutCtx()).toBeNull();
      asParent(a.identity);
      expect(await parentLayoutCtx()).toMatchObject({ parentId: a.identity.parentId, familyId: a.identity.familyId });
    });
  });

  describe("the sign-in page", () => {
    it("renders with a page to return to, and with anything else in its place", async () => {
      for (const next of ["/payments", ...HOSTILE, undefined]) {
        const html = await renderPage(ParentSignIn, { searchParams: { next: next as string } });
        expect(html).toContain("Send code");
        expect(html).not.toContain("evil.example");
      }
    });

    it("tells a parent confirming a new sign-in address to sign in with the one they use now", async () => {
      const hint = "sign in with the address you use now";
      expect(await renderPage(ParentSignIn, { searchParams: { next: "/family/email/Abc123-token_x" } })).toContain(hint);
      expect(await renderPage(ParentSignIn, { searchParams: { next: "/payments" } })).not.toContain(hint);
    });

    it("carries the club bar: the club's name and monogram, and no menu", async () => {
      const html = await renderPage(ParentSignIn);
      expect(html).toContain("<header class=\"bar\"><div class=\"wrap\"><span class=\"monogram\" aria-hidden=\"true\">BR</span><span class=\"club\">Booster Rocket</span>");
      expect(html).not.toContain("<a href=\"/payments\"");
      expect(html).toContain("<h1 class=\"page-title\">Sign in</h1>");
    });
  });

  describe("the family chooser", () => {
    it("sends a visitor with no session to sign in, keeping the page they asked for", async () => {
      expect(await pageOutcome(ChooseFamily, { searchParams: { next: "/payments" } })).toEqual({ redirect: "/sign-in?next=%2Fpayments" });
      expect(await pageOutcome(ChooseFamily, { searchParams: { next: "//evil.example" } })).toEqual({ redirect: "/sign-in" });
      expect(await pageOutcome(ChooseFamily)).toEqual({ redirect: "/sign-in" });
    });

    it("lists only the signed-in parent's own families, whatever the address says", async () => {
      const second = await seedGuardian({ parentId: a.identity.parentId, familyQboId: "QBO-ALDERQUIST-SECOND-7099" });
      asParentChoosing({ ...a.identity, families: [...a.identity.families, { guardianId: second.id, familyId: await recordOfCustomer("QBO-ALDERQUIST-SECOND-7099", "family") }] });
      for (const next of ["/payments", "//evil.example", b.spec.family.qboId]) {
        const html = await renderPage(ChooseFamily, { searchParams: { next } });
        expect(html).toContain(a.spec.family.name);
        for (const marker of b.markers) expect(html.toLowerCase()).not.toContain(marker.toLowerCase());
        expect(html).not.toContain("evil.example");
        // Neither family's QuickBooks id is on the page: the chooser binds each guardian row, and names it from its record.
        expect(html).not.toContain(a.spec.family.qboId);
        expect(html).not.toContain("QBO-ALDERQUIST-SECOND-7099");
      }
    });

    it("lands on the page asked for once a family is chosen", async () => {
      asParentChoosing(a.identity);
      await db.update(parentAuthSession).set({ familyId: null }).where(eq(parentAuthSession.id, a.session.id));
      expect(await redirectOf(chooseFamilyAction(a.identity.guardianId, "/payments"))).toBe("/payments");
      expect(await sessionFamily(a)).toBe(a.identity.familyId);
      expect(await redirectOf(chooseFamilyAction(a.identity.guardianId))).toBe("/");
    });

    it("lands on the home page when the page asked for is not a parent page of this site", async () => {
      asParent(a.identity);
      for (const next of HOSTILE) {
        expect(await redirectOf((chooseFamilyAction as (row: string, next: unknown) => Promise<void>)(a.identity.guardianId, next))).toBe("/");
      }
    });

    it("given another family's guardian row, changes nothing, says nothing of that family and keeps the page asked for", async () => {
      // Family A's parent, with family B's guardian row in the request: both as a parent who has a family chosen and as one who has not.
      for (const signIn of [() => asParent(a.identity), () => asParentChoosing(a.identity)]) {
        signIn();
        const before = { mine: await sessionFamily(a), theirs: await sessionFamily(b), refused: (await refusals()).length };
        const went = await redirectOf(chooseFamilyAction(b.identity.guardianId, "/payments"));
        expect(went).toBe("/choose-family?next=%2Fpayments");                 // back to the chooser: the same answer as for a row that does not exist
        expect(await redirectOf(chooseFamilyAction(crypto.randomUUID(), "/payments"))).toBe(went);
        expect(await redirectOf(chooseFamilyAction(a.spec.family.qboId, "/payments"))).toBe(went);   // a family's QuickBooks id is not a row's
        expect(await sessionFamily(a)).toBe(before.mine);
        expect(await sessionFamily(b)).toBe(before.theirs);
        const added = (await refusals()).slice(before.refused);
        expect(added).toHaveLength(3);
        expect(added.find((r) => (r.after as { guardianId?: string }).guardianId === b.identity.guardianId)).toMatchObject({ door: "parent", actorId: a.identity.parentId, targetId: a.identity.parentId,
          after: { reason: "family_not_enabled", guardianId: b.identity.guardianId } });
      }
      // The return path can't be used to say which family either: another family's id there is only a path that is dropped or kept.
      asParent(a.identity);
      expect(await redirectOf(chooseFamilyAction(a.identity.guardianId, `/${b.spec.family.qboId}`))).toBe(`/${b.spec.family.qboId}`);
      expect(await sessionFamily(a)).toBe(a.identity.familyId);
      expect(await sessionFamily(b)).toBe(b.identity.familyId);
    });

    it("is refused without a parent session, whatever it is given", async () => {
      await expect(chooseFamilyAction(a.identity.guardianId, "/payments")).rejects.toThrow("Not allowed");
      expect(await sessionFamily(a)).toBe(a.identity.familyId);
    });
  });
});
