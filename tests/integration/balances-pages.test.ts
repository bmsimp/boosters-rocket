import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, pageOutcome, renderPage, revalidatedPaths } from "../helpers/signed-in";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, familyMoney, role, roleAssignment, roleRule } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { formatMoney } from "@/lib/money/cents";
import { ADMIN_ONLY, GRANTABLE } from "@/lib/permissions/registry";
import BalancesPage from "@/app/staff/(app)/balances/page";
import FamilyBalancePage from "@/app/staff/(app)/balances/[familyId]/page";
import { askForMoneyRunAction } from "@/app/staff/(app)/balances/actions";
import { resetDb, seedStaff } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedTwoFamilies } from "../helpers/parent";
import { addToCache, fam, stu } from "../helpers/roster-cache";
import { startQboStub } from "../helpers/qbo-stub";
import { connectCompany } from "../helpers/money";

/**
 * The staff Balances pages (step 4): every family with what it owes, its oldest due date and when its figures were
 * read, with a filter and a search; one family's invoices; the families worth a look. The guard and its permission,
 * the audit row written before anything is shown, amounts through formatMoney, QuickBooks text as text.
 */
type Staff = Awaited<ReturnType<typeof seedStaff>>;
const withRole = async (email: string, patterns: string[]): Promise<Staff> => {
  const s = await seedStaff({ email, name: email });
  const [r] = await db.insert(role).values({ key: email, name: email }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
};
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => r.action === action);
const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'");
const owedBy = (spec: typeof FAMILY_A) => formatMoney((spec.invoices ?? []).filter((i) => !i.paid).reduce((sum, i) => sum + i.cents, 0));

let treasurer: Staff;
beforeEach(async () => {
  await resetDb();
  await seedTwoFamilies();
  // A family with nothing read yet, whose name is QuickBooks text that looks like markup; and one QuickBooks made inactive.
  await addToCache([fam("QBO-CHEN-9001", "Chen <b>Family</b>"), stu("QBO-CHEN-9002", "Kai <i>Chen</i>", "QBO-CHEN-9001"), fam("QBO-GONE-9003", "Gone Family", { active: false })]);
  treasurer = await withRole("treasurer@club.org", ["Finance.Balance.Read"]);
  asStaff(treasurer);
});

describe("the permission", () => {
  it("is an ordinary one a custom role can hold, and the pages and the button need it", async () => {
    expect(GRANTABLE).toContain("Finance.Balance.Read");
    expect(ADMIN_ONLY).not.toContain("Finance.Balance.Read");
    asStaff(await withRole("seasons@club.org", ["Season.*", "Roster.*"]));
    expect(await pageOutcome(BalancesPage)).toEqual({ redirect: "/refused" });
    expect(await pageOutcome(FamilyBalancePage, { params: { familyId: FAMILY_A.family.qboId } })).toEqual({ redirect: "/refused" });
    await expect(askForMoneyRunAction()).rejects.toThrow(AccessDenied);
    expect(await audits("money.family.read")).toEqual([]);
    expect(await audits("money.balances.read")).toEqual([]);
  });
});

describe("the Balances page", () => {
  it("lists every active family with what it owes, its oldest due date and when it was read, audited first", async () => {
    const text = textOf(await renderPage(BalancesPage));
    expect(text).toContain(`${FAMILY_A.family.name} 2 open invoices, oldest due 2026-12-01 · Read`);
    expect(text).toContain(owedBy(FAMILY_A));
    expect(text).toContain(`${FAMILY_B.family.name} 2 open invoices`);
    expect(text).toContain(owedBy(FAMILY_B));
    expect(text).toContain("Chen &lt;b&gt;Family&lt;/b&gt; Not read from QuickBooks yet");
    expect(text).not.toContain("Gone Family");
    expect(text).toContain("3 families.");
    expect((await audits("money.balances.read")).map((r) => [r.actorId, r.permission, r.after])).toEqual([[treasurer.id, "Finance.Balance.Read", { onlyOwing: false, search: null }]]);
  });

  it("renders QuickBooks text as text, and links each family to its own page", async () => {
    const html = await renderPage(BalancesPage);
    expect(html).toContain("Chen &lt;b&gt;Family&lt;/b&gt;");
    expect(html).not.toContain("<b>Family</b>");
    expect(html).toContain(`href="/staff/balances/${encodeURIComponent(FAMILY_A.family.qboId)}"`);
  });

  it("filters to the families that owe, and finds a family by its own name or a student's", async () => {
    await db.update(familyMoney).set({ totalCents: 0, invoices: [] }).where(eq(familyMoney.familyQboId, FAMILY_B.family.qboId));
    const owing = textOf(await renderPage(BalancesPage, { searchParams: { owing: "1" } }));
    expect(owing).toContain(FAMILY_A.family.name);
    expect(owing).not.toContain(FAMILY_B.family.name);
    expect(owing).not.toContain("Chen <b>Family</b>");
    expect(owing).toContain("1 of 3 families.");
    const found = textOf(await renderPage(BalancesPage, { searchParams: { q: FAMILY_B.students[1]!.name.split(" ")[0]!.toUpperCase() } }));
    expect(found).toContain(FAMILY_B.family.name);
    expect(found).not.toContain(FAMILY_A.family.name);
    expect(textOf(await renderPage(BalancesPage, { searchParams: { q: "nobody-by-this-name" } }))).toContain("No family matches.");
    // A search too long for any name is cut, not refused; an array in the address is ignored.
    expect(textOf(await renderPage(BalancesPage, { searchParams: { q: ["a", "b"], owing: ["1", "1"] } }))).toContain("3 families.");
    expect((await audits("money.balances.read")).map((r) => r.after)).toEqual([
      { onlyOwing: true, search: null }, { onlyOwing: false, search: FAMILY_B.students[1]!.name.split(" ")[0]!.toUpperCase() },
      { onlyOwing: false, search: "nobody-by-this-name" }, { onlyOwing: false, search: null },
    ]);
  });

  it("lists the families worth a look, with QuickBooks' balance and what the invoices add up to", async () => {
    await db.update(familyMoney).set({ checkedAt: new Date(), customerChecks: [
      { customerQboId: FAMILY_B.family.qboId, name: null, balanceCents: 824208 + 826410, invoicesCents: 824208 + 826410, currency: "USD" },
      { customerQboId: FAMILY_B.students[0]!.qboId, name: FAMILY_B.students[0]!.name, balanceCents: 12500, invoicesCents: 0, currency: "USD" },
    ] }).where(eq(familyMoney.familyQboId, FAMILY_B.family.qboId));
    const text = textOf(await renderPage(BalancesPage));
    expect(text).toContain(`Worth a look`);
    expect(text).toContain(`${FAMILY_B.family.name} ${FAMILY_B.students[0]!.name}: QuickBooks says $125.00, its open invoices add up to $0.00 Checked`);
    expect(text).not.toMatch(new RegExp(`${FAMILY_A.family.name} [^·]*QuickBooks says`));
  });

  it("asks the worker to read every family, refusing while QuickBooks isn't connected", async () => {
    expect(await askForMoneyRunAction()).toEqual({ ok: false, errors: ["QuickBooks isn't connected, or its roster hasn't been read yet, so there is nothing to read. See QuickBooks under Settings."] });
    const stub = await startQboStub();
    try {
      await connectCompany(stub);
      expect(await askForMoneyRunAction()).toEqual({ ok: true, message: "Asked. The worker starts within a minute and reads one family at a time; this page shows how far it has got." });
      expect(revalidatedPaths()).toContain("/staff/balances");
      expect((await audits("money.read_all.ask")).map((r) => [r.actorId, r.permission])).toEqual([[treasurer.id, "Finance.Balance.Read"]]);
      expect(textOf(await renderPage(BalancesPage))).toContain("A read of every family is asked for. The worker starts it within a minute.");
      expect(stub.apiCalls()).toEqual([]); // the page never waits on QuickBooks
    } finally { await stub.close(); }
  });
});

describe("one family's money", () => {
  it("audits the read before anything is shown, then shows the open invoices, the total and what was paid", async () => {
    const html = await renderPage(FamilyBalancePage, { params: { familyId: encodeURIComponent(FAMILY_A.family.qboId) } });
    expect((await audits("money.family.read")).map((r) => [r.actorId, r.permission, r.targetType, r.targetId])).toEqual([[treasurer.id, "Finance.Balance.Read", "qbo_customer", FAMILY_A.family.qboId]]);
    const text = textOf(html);
    expect(text).toContain("Invoice INV-ALDERQUIST-7101");
    expect(text).toContain(`Total ${owedBy(FAMILY_A)}`);
    expect(text).toContain(`Paid in the last 12 months Invoice INV-ALDERQUIST-7103 Invoice date 2026-10-01 ${formatMoney(717311)} Paid`);
    expect(text).toContain(`With the invoices raised on ${[...FAMILY_A.students.map((s) => s.name), FAMILY_A.parent.name].sort().join(", ")}.`);
    // Nothing of the other family.
    for (const i of FAMILY_B.invoices!) expect(html).not.toContain(i.number);
  });

  it("answers 404, and audits nothing, for an id that isn't an active family: a student's, an inactive family's, one that isn't there", async () => {
    for (const familyId of [FAMILY_A.students[0]!.qboId, "QBO-GONE-9003", "NOBODY", "%E0%A4%A", "x".repeat(65)]) {
      expect(await pageOutcome(FamilyBalancePage, { params: { familyId } }), familyId).toEqual({ notFound: true });
    }
    expect(await audits("money.family.read")).toEqual([]);
  });

  it("says so when nothing has been read, renders QuickBooks text as text, and says when the check hasn't run", async () => {
    const html = await renderPage(FamilyBalancePage, { params: { familyId: "QBO-CHEN-9001" } });
    expect(html).toContain("Chen &lt;b&gt;Family&lt;/b&gt;");
    expect(html).toContain("Kai &lt;i&gt;Chen&lt;/i&gt;");
    expect(textOf(html)).toContain("Nothing has been read from QuickBooks for this family yet");
    expect(textOf(html)).toContain("The worker hasn't compared this family's balances in QuickBooks with its invoices yet.");
  });

  it("shows the last check, customer by customer", async () => {
    await db.update(familyMoney).set({ checkedAt: new Date(), customerChecks: [
      { customerQboId: FAMILY_A.family.qboId, name: null, balanceCents: 1428316, invoicesCents: 1428316, currency: "USD" },
      { customerQboId: FAMILY_A.students[0]!.qboId, name: FAMILY_A.students[0]!.name, balanceCents: -2500, invoicesCents: 0, currency: "USD" },
    ] }).where(eq(familyMoney.familyQboId, FAMILY_A.family.qboId));
    const text = textOf(await renderPage(FamilyBalancePage, { params: { familyId: FAMILY_A.family.qboId } }));
    expect(text).toContain(`The family itself The same ${formatMoney(1428316)}`);
    expect(text).toContain(`${FAMILY_A.students[0]!.name} Different: its open invoices add up to $0.00 -$25.00`);
  });
});
