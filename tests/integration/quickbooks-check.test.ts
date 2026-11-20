import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, asStaff, pageOutcome, renderPage } from "../helpers/signed-in";

// The check sends every request the portal makes: here to the stub, never to Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, qboCheckRecord, qboCheckRun, qboConnection, qboCustomer } from "@/lib/db/schema";
import { runCheckAction } from "@/app/staff/(app)/settings/quickbooks/check/actions";
import CheckRequestsPage from "@/app/staff/(app)/settings/quickbooks/check/page";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import { AccessDenied } from "@/lib/guards";
import { EXPECTATIONS, notRunWords } from "@/lib/quickbooks/sandbox-check/expectations";
import { lastCheck, lastCheckWords } from "@/lib/quickbooks/sandbox-check/view";
import { runSandboxCheck } from "@/lib/quickbooks/sandbox-check/run";
import {
  checkCreateCustomer, checkCreateInvoice, checkMove, checkRename, checkSetActive, checkUpdateContact, checkUpdateEmail, checkVoidInvoice, type CheckRun,
} from "@/lib/quickbooks/sandbox-check/writes";
import { healthReport } from "@/lib/health/report";
import { refreshRoster } from "@/lib/roster/refresh";
import { clearRosterOfOtherCompany } from "@/lib/roster/source";
import { resetDb, seedStaff } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { REALM, staffWith, WORKER } from "../helpers/roster-writes";
import { holdTheRosterLock } from "../helpers/reconcile";
import { checkCompany, lastRun, readInvoice, recordsOf } from "../helpers/sandbox-check";
import { seedSignedInParent } from "../helpers/parent";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

let admin: Awaited<ReturnType<typeof seedStaff>>;
beforeEach(async () => {
  await resetDb(); stub.reset();
  admin = await seedStaff({ email: "admin@club.org", name: "Admin Person", admin: true });
});

const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const run = (writes = true) => runSandboxCheck({ staffUserId: admin.id, label: admin.email, ip: "203.0.113.9", writes });
/** The ids of the customers the stub holds that the check made: every one named "Booster Rocket check". */
const checkCustomers = () => stub.customers.filter((c) => String(c.DisplayName).startsWith("Booster Rocket check"));
const WRITE_KEYS = EXPECTATIONS.filter((x) => x.group === "writes").map((x) => x.key);
const READ_KEYS = EXPECTATIONS.filter((x) => x.group === "reads").map((x) => x.key);

describe("the check of the portal's requests against an Intuit sandbox company (roadmap step 7)", () => {
  it("finds every request answering as the portal expects, and leaves every record it made inactive", async () => {
    await checkCompany(stub);
    const answer = await run();
    expect(answer).toMatchObject({ ok: true, outcome: "passed" });
    const { run: r, byKey } = await lastRun();
    expect(r.results.map((x) => x.key)).toEqual(EXPECTATIONS.map((x) => x.key));
    const odd = r.results.filter((x) => x.outcome !== "as_expected" && x.outcome !== "learned");
    expect(odd).toEqual([]);
    expect(byKey.invoices_list_form!.learned).toMatchObject({ form: "list" });
    expect(byKey.pay_links!.learned).toMatchObject({ hosts: ["connect.intuit.com"], unsafe: 0 });
    expect(byKey.empty_answer!.learned).toMatchObject({ shape: "empty", accepted: true });
    // As the sandbox answered on 2026-11-17, and what the portal now relies on.
    expect(byKey.inactive_with_balance).toMatchObject({ outcome: "as_expected", learned: { code: "fault_6220" } });
    expect(byKey.family_inactive_while_under).toMatchObject({ outcome: "as_expected", learned: { code: "fault_800" } });
    expect(byKey.family_inactive_after).toMatchObject({ outcome: "as_expected", learned: { code: "accepted", familyVersionRose: false } });
    // The Pay link probe: made as a buy-out invoice is made, no link; with a bill-to email address, a link; nothing emailed.
    expect(byKey.pay_link_probe).toMatchObject({ outcome: "learned", learned: { found: true, plainLinked: false, emailLinked: true, emailStatus: "NotSet" } });
    expect(byKey.pay_links).toMatchObject({ outcome: "learned", learned: { ownLinked: false } });
    const invoicePosts = posts().filter((p) => p.path.endsWith("/invoice") && p.query.get("operation") === null).map((p) => JSON.parse(p.body) as Record<string, unknown>);
    expect(invoicePosts.map((b) => b.BillEmail ?? null)).toEqual([null, { Address: expect.stringMatching(/^check-parent-[a-z0-9-]+@example\.com$/) }]);
    expect(invoicePosts.every((b) => b.EmailStatus === "NotSet")).toBe(true);
    expect(r).toMatchObject({ environment: "sandbox", writes: true, realmId: REALM, outcome: "passed", stopCode: null });
    // Two families, a student and a parent, all named for the check, and one invoice: every one closed.
    // The name already in use made nothing: its row is closed with no id. So did the parent of the same name under the
    // second family, which this stub (as QuickBooks is understood to) refuses as a name in use (stage 3's slice 9h).
    const all = await recordsOf(r.id), made = all.filter((m) => m.qboId !== null);
    expect(all.filter((m) => m.qboId === null).map((m) => [m.kind, m.lastCode, m.closedAt !== null]).sort()).toEqual([["family", "fault_6240", true], ["parent", "fault_6240", true]]);
    expect(byKey.duplicate_name_other_parent).toMatchObject({ outcome: "learned", learned: { code: "fault_6240" } });
    expect(made.map((m) => m.kind).sort()).toEqual(["family", "family", "invoice", "invoice", "parent", "student"]);
    expect(made.every((m) => m.closedAt !== null)).toBe(true);
    expect(checkCustomers()).toHaveLength(4);
    expect(checkCustomers().every((c) => c.Active === false)).toBe(true);
    expect(checkCustomers().every((c) => String(c.DisplayName).includes(r.tag))).toBe(true);
    for (const m of made.filter((x) => x.kind === "invoice")) expect(stub.invoices.find((i) => i.Id === m.qboId)).toMatchObject({ TotalAmt: 0, Balance: 0 });
    // Every write went to a record the check made, or made one.
    const mine = new Set(made.map((m) => m.qboId));
    for (const p of posts()) {
      const body = JSON.parse(p.body) as { Id?: string; CustomerRef?: { value: string }; ParentRef?: { value: string } };
      if (body.Id !== undefined) expect(mine.has(body.Id), p.body).toBe(true);
      if (body.CustomerRef) expect(mine.has(body.CustomerRef.value)).toBe(true);
      if (body.ParentRef) expect(mine.has(body.ParentRef.value)).toBe(true);
    }
    // The real customers are as they were.
    expect(stub.customers.filter((c) => !checkCustomers().includes(c)).every((c) => c.SyncToken === "0")).toBe(true);
    // Audited when it starts and ends, with counts.
    expect(await audits("quickbooks.check.start")).toHaveLength(1);
    const [end] = await audits("quickbooks.check.end");
    expect(end!.after).toMatchObject({ outcome: "passed", notAsExpected: 0, made: 6, open: 0 });
  });

  it("keeps no QuickBooks text but its own names: no family's name, amount or address", async () => {
    await checkCompany(stub);
    stub.customers = stub.customers.map((c) => ({ ...c, Balance: 123.45 }));
    await run();
    const { run: r } = await lastRun();
    const kept = JSON.stringify(r.results);
    for (const c of stub.customers.filter((x) => !checkCustomers().includes(x))) expect(kept).not.toContain(String(c.DisplayName));
    expect(kept).not.toMatch(/123\.45|12345|Ana@|example\.com|scs-v1|Check Street|555-/i);
  });

  it("never makes its records portal families: a roster refresh afterwards gives them no sign-in and lists them as inactive", async () => {
    await checkCompany(stub);
    await run();
    const r = await refreshRoster(WORKER);
    expect(r.ok).toBe(true);
    const ids = checkCustomers().map((c) => String(c.Id));
    const cached = await db.select().from(qboCustomer);
    const theirs = cached.filter((c) => ids.includes(c.qboId));
    expect(theirs).toHaveLength(4);
    expect(theirs.every((c) => !c.active && c.displayName.startsWith("Booster Rocket check"))).toBe(true);
    const links = await db.select().from(guardian);
    expect(links.filter((g) => ids.includes(g.familyQboId ?? "") || ids.includes(g.sourceQboId ?? ""))).toEqual([]);
  });

  it("checks pass links, empty answers and the list form without a write when the writes are off", async () => {
    await checkCompany(stub);
    await run(false);
    const { byKey } = await lastRun();
    for (const k of READ_KEYS) expect(byKey[k]!.outcome, k).not.toBe("not_as_expected");
    for (const k of WRITE_KEYS) expect(byKey[k]!.outcome, k).toBe("not_run");
    expect(posts()).toEqual([]);
  });
});

/** One way QuickBooks might answer otherwise, and the requests that must then read "not as expected". */
type Case = { name: string; set: (stub: QboStub) => void; fails: string[] };
const CASES: Case[] = [
  { name: "the customer types aren't a list", set: (s) => { s.oddRosterAnswer = { types: { QueryResponse: { CustomerType: {} } } }; }, fails: ["customer_types"] },
  { name: "the customers aren't a list", set: (s) => { s.oddRosterAnswer = { customers: { QueryResponse: { Customer: {} } } }; }, fails: ["customers"] },
  { name: "the item query answers a Fault", set: (s) => { s.oddItemAnswer = { body: { Fault: { Error: [{ code: "4000" }] } } }; }, fails: ["items"] },
  { name: "the list form answers other customers' invoices", set: (s) => { s.oddInvoiceAnswer = { body: { QueryResponse: { Invoice: [readInvoice("950", "30")] } }, inFormOnly: true }; }, fails: ["invoices_list_form"] },
  // With every invoice query answered oddly the check can't find its own invoices to void them, so the student still
  // owes and QuickBooks refuses to make it inactive (6220), and its family after it (800): the check rightly says its
  // records aren't all inactive.
  { name: "the one-customer form answers other customers' invoices", set: (s) => { s.oddInvoiceAnswer = { body: { QueryResponse: { Invoice: [readInvoice("950", "30")] } } }; }, fails: ["invoices_one_form", "all_inactive"] },
  { name: "an empty answer has another shape", set: (s) => { s.oddInvoiceAnswer = { body: { QueryResponse: { Invoice: {} } } }; }, fails: ["empty_answer", "all_inactive"] },
  { name: "an invoice has no due date", set: (s) => { s.invoices.push(readInvoice("903", "10", { DueDate: undefined })); }, fails: ["invoice_fields"] },
  { name: "an invoice line names a product that isn't on the list", set: (s) => { s.invoices.push(readInvoice("903", "10", { Line: [{ DetailType: "SalesItemLineDetail", Amount: 5, SalesItemLineDetail: { ItemRef: { value: "99" } } }] })); }, fails: ["invoice_items"] },
  { name: "pay links are on another host", set: (s) => { s.invoices.push(readInvoice("903", "10", { InvoiceLink: "https://pay.example.net/t/903" })); }, fails: ["pay_links"] },
  { name: "no balance comes with a customer", set: (s) => { s.quirks.balances = false; }, fails: ["balance_with_jobs", "own_balance"] },
  { name: "a create leaves out the customer type", set: (s) => { s.quirks.createDrops = ["CustomerTypeRef"]; }, fails: ["create_family"] },
  { name: "a student isn't billed with its family", set: (s) => { s.quirks.createDrops = ["BillWithParent"]; }, fails: ["create_student"] },
  { name: "a parent's email isn't kept on a create", set: (s) => { s.quirks.createDrops = ["PrimaryEmailAddr"]; }, fails: ["create_parent"] },
  { name: "a name in use gives another code", set: (s) => { s.quirks.duplicateCode = "6000"; }, fails: ["duplicate_name"] },
  { name: "a phone change changes another field", set: (s) => { s.onApiRequest = changeAlongside(s, "555-0100"); }, fails: ["contact_phone"] },
  { name: "an address change changes another field", set: (s) => { s.onApiRequest = changeAlongside(s, "1 Check Street"); }, fails: ["contact_address"] },
  { name: "an email change changes a customer under the family", set: (s) => { s.onApiRequest = changeAlongside(s, "check-family-", true); }, fails: ["email_update"] },
  { name: "a rename changes another field", set: (s) => { s.onApiRequest = changeAlongside(s, "family A renamed"); }, fails: ["rename"] },
  { name: "a move changes another field", set: (s) => { s.onApiRequest = changeAlongside(s, "\"ParentRef\"", false, true); }, fails: ["move"] },
  { name: "an old version gives another code", set: (s) => { s.quirks.staleCode = "5000"; }, fails: ["contact_stale", "email_stale", "rename_stale", "void_stale"] },
  { name: "a phone of 30 characters is refused", set: (s) => { s.quirks.limits["PrimaryPhone.FreeFormNumber"] = 25; }, fails: ["phone_limit"] },
  { name: "a phone of 31 characters is taken", set: (s) => { delete s.quirks.limits["PrimaryPhone.FreeFormNumber"]; }, fails: ["phone_limit"] },
  { name: "a city of 100 characters is refused", set: (s) => { s.quirks.limits["BillAddr.City"] = 50; }, fails: ["address_limits"] },
  { name: "an empty value keeps what was there", set: (s) => { s.quirks.emptyKeeps = true; }, fails: ["clear_fields"] },
  { name: "an email field of two addresses keeps only the first", set: (s) => { s.quirks.emailFirstOnly = true; }, fails: ["email_several"] },
  { name: "an email field of 100 characters is refused", set: (s) => { s.quirks.limits["PrimaryEmailAddr.Address"] = 80; }, fails: ["email_length"] },
  { name: "an email field that isn't an address is taken", set: (s) => { s.quirks.checkEmail = false; }, fails: ["email_invalid"] },
  { name: "an invoice create is refused", set: (s) => { s.invoiceFault = "6000"; }, fails: ["invoice_create"] },
  { name: "the private note isn't kept", set: (s) => { s.quirks.keepPrivateNote = false; }, fails: ["invoice_note"] },
  { name: "the invoice is emailed", set: (s) => { s.quirks.invoiceEmailStatus = "EmailSent"; }, fails: ["invoice_no_email"] },
  { name: "a void is refused", set: (s) => { s.onApiRequest = (c) => { s.invoiceFault = c.query.get("operation") === "void" ? "6000" : null; }; }, fails: ["invoice_void", "all_inactive"] },
  { name: "a customer with an open balance is made inactive", set: (s) => { s.quirks.inactiveWithBalance = null; }, fails: ["inactive_with_balance"] },
  { name: "a family is made inactive while a customer under it is active", set: (s) => { s.quirks.inactiveWithActiveUnder = null; }, fails: ["family_inactive_while_under"] },
  { name: "the invoice with a bill-to email carries a link that isn't to QuickBooks' payment page", set: (s) => { s.quirks.invoiceLinkHost = "pay.example.net"; }, fails: ["pay_link_probe"] },
  { name: "a family can't be made inactive", set: (s) => { s.onApiRequest = (c) => { s.updateFault = /"Active":false/.test(c.body) && nameOf(s, c.body)?.endsWith("family B") ? "6000" : null; }; }, fails: ["all_inactive"] },
];

/** The name of the customer a write's body names by Id. */
const nameOf = (s: QboStub, body: string): string | undefined => {
  const id = (JSON.parse(body || "{}") as { Id?: unknown }).Id;
  return s.customers.find((c) => c.Id === id)?.DisplayName as string | undefined;
};
/**
 * As a write whose body holds `marker` arrives, someone changes another field of the record in QuickBooks: the record
 * then holds more than the write meant to change. `sub`: a customer under it changes instead. `student`: only on a write
 * to the check's student.
 */
function changeAlongside(s: QboStub, marker: string, sub = false, student = false) {
  return (c: { method: string; body: string }) => {
    if (c.method !== "POST" || !c.body.includes(marker)) return;
    const id = (JSON.parse(c.body) as { Id?: unknown }).Id;
    if (student && !nameOf(s, c.body)?.endsWith("student")) return;
    const target = sub ? s.customers.find((x) => (x.ParentRef as { value?: unknown } | undefined)?.value === id) : s.customers.find((x) => x.Id === id);
    if (target) target.GivenName = "Changed in QuickBooks";
  };
}

describe("a parent of the same name under another family (stage 3's slice 9h)", () => {
  it("is learned either way: refused as a name in use above, taken here, and then made inactive before family B", async () => {
    await checkCompany(stub);
    stub.quirks.namesUnderParent = true;
    expect(await run()).toMatchObject({ ok: true, outcome: "passed" });
    const { run: r, byKey } = await lastRun();
    expect(byKey.duplicate_name_other_parent).toMatchObject({ outcome: "learned", learned: { code: "accepted" } });
    const made = (await recordsOf(r.id)).filter((m) => m.qboId !== null);
    expect(made.filter((m) => m.kind === "parent")).toHaveLength(2);
    expect(made.every((m) => m.closedAt !== null)).toBe(true);
    // Two parents of one name, one under each check family, both inactive, and both families after them.
    const parents = checkCustomers().filter((c) => String(c.DisplayName).endsWith(" parent"));
    expect(parents).toHaveLength(2);
    expect(new Set(parents.map((c) => (c.ParentRef as { value: string }).value)).size).toBe(2);
    expect(checkCustomers().every((c) => c.Active === false)).toBe(true);
    // Every write went to a record the check made, or made one.
    const mine = new Set(made.map((m) => m.qboId));
    for (const p of posts()) {
      const body = JSON.parse(p.body) as { Id?: string; ParentRef?: { value: string } };
      if (body.Id !== undefined) expect(mine.has(body.Id), p.body).toBe(true);
      if (body.ParentRef) expect(mine.has(body.ParentRef.value)).toBe(true);
    }
  });
});

describe("each request read as not answering as the portal expects", () => {
  it.each(CASES)("$name", async ({ set, fails }) => {
    await checkCompany(stub);
    set(stub);
    const answer = await run();
    expect(answer).toMatchObject({ ok: true, outcome: "not_as_expected" });
    const { byKey } = await lastRun();
    const notAsExpected = Object.values(byKey).filter((x) => x.outcome === "not_as_expected").map((x) => x.key);
    for (const k of fails) expect(notAsExpected, k).toContain(k);
    // Nothing the check made is left active, but where closing it was what failed.
    if (!fails.includes("all_inactive")) expect(checkCustomers().filter((c) => c.Active !== false)).toEqual([]);
  });

  it("says what a refused list form means: the portal asks one customer at a time, which works", async () => {
    await checkCompany(stub);
    stub.refuseInQuery = true;
    expect(await run()).toMatchObject({ ok: true, outcome: "passed" });
    const { byKey } = await lastRun();
    expect(byKey.invoices_list_form).toMatchObject({ outcome: "as_expected", learned: { form: "one_at_a_time", refusal: "http_400" } });
  });

  it("notes, and doesn't fail, its own invoice without a Pay link, and no longer says the company may not take payments when others carry one", async () => {
    await checkCompany(stub);
    expect(await run()).toMatchObject({ ok: true, outcome: "passed" });
    const { byKey } = await lastRun();
    expect(byKey.pay_links).toMatchObject({ outcome: "learned", code: "no_link", learned: { ownLinked: false, withLink: 2 } });
    const words = EXPECTATIONS.find((x) => x.key === "pay_links")!.learned(byKey.pay_links!.learned);
    expect(words).not.toContain("may not");
    expect(words).toContain("so the company does take payments online");
    expect(EXPECTATIONS.find((x) => x.key === "pay_link_probe")!.learned(byKey.pay_link_probe!.learned)).toContain("only to an invoice with an email address");
  });

  it("says a company whose invoices carry no Pay link at all may not take payments online", async () => {
    await checkCompany(stub);
    stub.quirks.invoiceLinkHost = null;
    stub.invoices = stub.invoices.map((i) => Object.fromEntries(Object.entries(i).filter(([k]) => k !== "InvoiceLink")));
    expect(await run()).toMatchObject({ ok: true, outcome: "passed" });
    const { byKey } = await lastRun();
    expect(byKey.pay_link_probe).toMatchObject({ outcome: "learned", learned: { plainLinked: false, emailLinked: false } });
    expect(EXPECTATIONS.find((x) => x.key === "pay_links")!.learned(byKey.pay_links!.learned)).toContain("only when the company takes payments online");
  });

  it("finds it not as expected when QuickBooks takes a family with customers under it active, or a customer with a balance", async () => {
    await checkCompany(stub);
    stub.quirks.inactiveWithBalance = null;
    stub.inactiveTakesChildren = true;
    expect(await run()).toMatchObject({ ok: true, outcome: "not_as_expected" });
    const { byKey } = await lastRun();
    expect(byKey.inactive_with_balance).toMatchObject({ outcome: "not_as_expected", learned: { code: "accepted" } });
    expect(byKey.family_inactive_while_under).toMatchObject({ outcome: "not_as_expected", learned: { code: "accepted", childrenInactive: true } });
    expect(byKey.family_inactive_after).toMatchObject({ outcome: "not_run", code: "needs_earlier" });
    expect(checkCustomers().every((c) => c.Active === false)).toBe(true);
  });
});

describe("the writes are only for an Intuit sandbox company", () => {
  it("reads a production company and changes nothing, from the action too", async () => {
    await checkCompany(stub, { environment: "production" });
    asStaff(admin);
    const r = await runCheckAction();
    // Every read answered as expected, but none of the changes was tried: said as a pass, not as needing attention.
    expect(r).toMatchObject({ ok: true });
    expect(r).not.toHaveProperty("attention");
    expect(posts()).toEqual([]);
    const { run: last, byKey } = await lastRun();
    expect(last).toMatchObject({ environment: "production", writes: false });
    for (const k of WRITE_KEYS) expect(byKey[k], k).toMatchObject({ outcome: "not_run", code: "production" });
    expect(await recordsOf(last.id)).toEqual([]);
    const html = await renderPage(CheckRequestsPage);
    expect(html).toContain("This is the club&#x27;s real books, so the check only reads.");
    expect(html).toContain("The club&#x27;s real books (reads only)");
  });

  it("sends no write even when the check is asked for them on a production company", async () => {
    await checkCompany(stub, { environment: "production" });
    await run(true);
    expect(posts()).toEqual([]);
  });

  it("refuses every write in the module that sends it, for a production company, with nothing sent", async () => {
    await checkCompany(stub);
    const [row] = await db.insert(qboCheckRun).values({ realmId: REALM, environment: "sandbox", writes: true, tag: "t", startedBy: admin.id }).returning();
    const r: CheckRun = { id: row!.id, realmId: REALM, actor: { door: "staff", id: admin.id, label: admin.email }, ip: null };
    const famRow = await made(r.id, "family", stub, "Booster Rocket check t family A");
    const stuRow = await made(r.id, "student", stub, "Booster Rocket check t student", famRow);
    await db.insert(qboCheckRecord).values({ runId: r.id, realmId: REALM, kind: "invoice", qboId: "5001", name: "m" });
    await db.update(qboConnection).set({ environment: "production" });
    const before = stub.customers.map((c) => JSON.stringify(c));
    for (const send of everyWrite(r, famRow, stuRow, "5001")) await expect(send()).rejects.toMatchObject({ code: "not_sandbox" });
    await expect(checkMove(r, stuRow, "0", famRow)).rejects.toMatchObject({ code: "not_sandbox" });
    await expect(checkCreateCustomer(r, { kind: "family", name: "Booster Rocket check t family B", typeQboId: "1", familyQboId: null, email: null })).rejects.toMatchObject({ code: "not_sandbox" });
    // Nothing was listed as made, either.
    expect(await db.select().from(qboCheckRecord)).toHaveLength(3);
    expect(posts()).toEqual([]);
    expect(stub.customers.map((c) => JSON.stringify(c))).toEqual(before);
  });

  it("refuses every write naming a record the check did not make, or another run made, or of another kind", async () => {
    await checkCompany(stub);
    const [row] = await db.insert(qboCheckRun).values({ realmId: REALM, environment: "sandbox", writes: true, tag: "t", startedBy: admin.id }).returning();
    const [other] = await db.insert(qboCheckRun).values({ realmId: REALM, environment: "sandbox", writes: true, tag: "u", startedBy: admin.id }).returning();
    const r: CheckRun = { id: row!.id, realmId: REALM, actor: { door: "staff", id: admin.id, label: admin.email }, ip: null };
    const othersFamily = await made(other!.id, "family", stub, "Booster Rocket check u family A");
    const mine = await made(r.id, "family", stub, "Booster Rocket check t family A");
    // A real family and student of the company, another run's family, an id of another kind, and ids that aren't QuickBooks ids.
    for (const id of ["10", "12", othersFamily, "5001", "abc", "", "10 or 1=1"]) {
      for (const send of everyWrite(r, id, id, id)) await expect(send(), id).rejects.toMatchObject({ code: "not_mine" });
      await expect(checkMove(r, id, "0", mine)).rejects.toMatchObject({ code: "not_mine" });
      await expect(checkCreateCustomer(r, { kind: "student", name: "Booster Rocket check t s", typeQboId: "3", familyQboId: id, email: null })).rejects.toMatchObject({ code: "not_mine" });
    }
    expect(posts()).toEqual([]);
    expect(await db.select().from(qboCheckRecord).where(eq(qboCheckRecord.kind, "student"))).toEqual([]);
  });

  it("stops when a different company is connected part way, and sends that company nothing", async () => {
    await checkCompany(stub);
    let changed = false;
    stub.onApiRequest = async (c) => {
      if (!changed && c.method === "POST") { changed = true; await db.update(qboConnection).set({ realmId: "9130000000000999" }); }
    };
    const answer = await run();
    expect(answer).toMatchObject({ ok: true, outcome: "stopped" });
    const { run: last } = await lastRun();
    expect(last.stopCode).toBe("other_company");
    // The first create was already on its way; nothing after it was sent.
    expect(posts()).toHaveLength(1);
    expect((await recordsOf(last.id)).filter((m) => m.closedAt === null)).toHaveLength(1);
  });
});

describe("a run cut off part way", () => {
  it("leaves its records listed, and the next run makes them inactive before it makes anything", async () => {
    await checkCompany(stub);
    // QuickBooks can't be reached once the student exists: the run stops, and can't close what it made.
    stub.onApiRequest = (c) => { if (checkCustomers().some((x) => String(x.DisplayName).endsWith("student")) && c.method === "POST") stub.dropApi = true; };
    expect(await run()).toMatchObject({ ok: true, outcome: "stopped" });
    const { run: first } = await lastRun();
    expect(first.stopCode).toBe("unreachable");
    const open = (await recordsOf(first.id)).filter((m) => m.closedAt === null);
    expect(open.map((m) => m.kind).sort()).toEqual(["family", "family", "student"]);
    asStaff(admin);
    const html = await renderPage(CheckRequestsPage);
    expect(html).toContain("Left from a check that didn&#x27;t finish");
    for (const m of open) expect(html).toContain(m.name);

    stub.onApiRequest = null; stub.dropApi = false;
    stub.calls.length = 0;
    expect(await run()).toMatchObject({ ok: true, outcome: "passed" });
    // The first writes of the second run make the first run's records inactive: student first, then the families.
    const firstPosts = posts().slice(0, 3).map((p) => JSON.parse(p.body) as { Id?: string; Active?: boolean });
    expect(firstPosts.map((b) => b.Active)).toEqual([false, false, false]);
    expect(firstPosts.map((b) => b.Id).sort()).toEqual(open.map((m) => m.qboId).sort());
    expect((await recordsOf(first.id)).every((m) => m.closedAt !== null)).toBe(true);
    expect(checkCustomers().every((c) => c.Active === false)).toBe(true);
  });

  it("marks a run the server stopped as cut off, and finds a create whose answer was lost by its name", async () => {
    await checkCompany(stub);
    const [cut] = await db.insert(qboCheckRun).values({ realmId: REALM, environment: "sandbox", writes: true, tag: "2026-11-01 dead", startedBy: admin.id }).returning();
    // The create reached QuickBooks, and the server stopped before its answer was recorded.
    stub.customers.push({ Id: "70", DisplayName: "Booster Rocket check 2026-11-01 dead family A", Active: true, SyncToken: "0", CustomerTypeRef: { value: "1" } });
    await db.insert(qboCheckRecord).values({ runId: cut!.id, realmId: REALM, kind: "family", name: "Booster Rocket check 2026-11-01 dead family A" });
    expect(await run()).toMatchObject({ ok: true, outcome: "passed" });
    const [after] = await db.select().from(qboCheckRun).where(eq(qboCheckRun.id, cut!.id));
    expect(after).toMatchObject({ outcome: "cut_off", stopCode: "cut_off" });
    expect(await audits("quickbooks.check.cut_off")).toHaveLength(1);
    expect(stub.customers.find((c) => c.Id === "70")!.Active).toBe(false);
    const [rec] = await recordsOf(cut!.id);
    expect(rec).toMatchObject({ qboId: "70" });
    expect(rec!.closedAt).not.toBeNull();
  });

  it("forgets the records it made when a different company is connected, and keeps the runs", async () => {
    await checkCompany(stub);
    await run();
    const { run: r } = await lastRun();
    expect((await recordsOf(r.id)).length).toBeGreaterThan(0);
    // The clear a change of company would run (until stage 4 a different company is refused before it can: open question 18).
    expect(await clearRosterOfOtherCompany("9130000000000777", { actor: WORKER.actor, ip: null })).toBe(true);
    expect(await db.select().from(qboCheckRecord)).toEqual([]);
    expect(await db.select().from(qboCheckRun)).toHaveLength(1);
    expect(await audits("quickbooks.check.records.cleared")).toHaveLength(1);
  });

  it("closes the name-in-use create whose answer was lost as making nothing, makes the rest inactive, and the next run passes", async () => {
    await checkCompany(stub);
    // The connection drops on the create that names family A a second time: the name the check already owns.
    let familyA = 0;
    stub.onApiRequest = (c) => {
      stub.dropApi = false;
      if (c.method === "POST" && /family A"/.test(c.body) && !/"Id"/.test(c.body) && ++familyA === 2) stub.dropApi = true;
    };
    expect(await run()).toMatchObject({ ok: true, outcome: "stopped" });
    const { run: first } = await lastRun();
    expect(first.stopCode).toBe("unreachable");
    const rows = await recordsOf(first.id);
    expect(rows.filter((m) => m.closedAt === null)).toEqual([]);
    expect(rows.filter((m) => m.qboId === null).map((m) => m.lastCode)).toEqual(["name_of_listed"]);
    expect(checkCustomers().filter((c) => c.Active !== false)).toEqual([]);
    stub.onApiRequest = null; stub.dropApi = false;
    expect(await run()).toMatchObject({ ok: true, outcome: "passed" });
  });

  it("closes an earlier run's lost create that no customer carries the name of: QuickBooks made nothing", async () => {
    await checkCompany(stub);
    const [cut] = await db.insert(qboCheckRun).values({ realmId: REALM, environment: "sandbox", writes: true, tag: "2026-11-01 lost", startedBy: admin.id }).returning();
    await db.insert(qboCheckRecord).values({ runId: cut!.id, realmId: REALM, kind: "family", name: "Booster Rocket check 2026-11-01 lost family A" });
    expect(await run()).toMatchObject({ ok: true, outcome: "passed" });
    const [rec] = await recordsOf(cut!.id);
    expect(rec).toMatchObject({ qboId: null, lastCode: "not_made" });
    expect(rec!.closedAt).not.toBeNull();
  });

  it("runs one at a time", async () => {
    await checkCompany(stub);
    const [a, b] = await Promise.all([run(false), run(false)]);
    expect([a, b].filter((x) => !x.ok)).toEqual([{ ok: false, reason: "running" }]);
  });
});

describe("a run asked to try the changes that tried none is not a pass", () => {
  it("says some changes weren't tried while a roster refresh holds the lock, on the page, the settings view and Health", async () => {
    await checkCompany(stub);
    const lock = await holdTheRosterLock();
    try {
      expect(await run()).toMatchObject({ ok: true, outcome: "incomplete" });
    } finally { await lock.release(); }
    expect(posts()).toEqual([]);
    const { run: r, byKey } = await lastRun();
    expect(r.outcome).toBe("incomplete");
    for (const k of WRITE_KEYS) expect(byKey[k], k).toMatchObject({ outcome: "not_run", code: "roster_busy" });
    const words = lastCheckWords(await lastCheck());
    expect(words).not.toContain("every request answered as the portal expects");
    expect(words).toContain(`${WRITE_KEYS.length} of the changes weren't tried`);
    asStaff(admin);
    expect(await renderPage(CheckRequestsPage)).toContain("Finished, but some changes weren&#x27;t tried");
    expect((await healthReport()).find((l) => l.key === "quickbooks")!.notes).toContain(words);
  });

  it("says the company has no customer type to make the check's records with", async () => {
    await checkCompany(stub);
    stub.types = [];
    expect(await run()).toMatchObject({ ok: true, outcome: "incomplete" });
    const { byKey } = await lastRun();
    expect(byKey.create_family).toMatchObject({ outcome: "not_run", code: "no_types" });
    expect(notRunWords("no_types")).toContain("no active customer type");
    expect(posts()).toEqual([]);
  });

  it("still passes a read-only run of a sandbox company: it wasn't asked to try the changes", async () => {
    await checkCompany(stub);
    expect(await run(false)).toMatchObject({ ok: true, outcome: "passed" });
    expect(lastCheckWords(await lastCheck())).toContain("reads only: every request answered as the portal expects");
  });
});

describe("who may run it, and where it is said", () => {
  it("is Admin only: staff with every other permission, and a parent, are refused", async () => {
    await checkCompany(stub);
    stub.calls.length = 0;
    const everything = await staffWith("treasurer@club.org", ["*"]);
    asStaff(everything);
    await expect(runCheckAction()).rejects.toBeInstanceOf(AccessDenied);
    expect(await pageOutcome(CheckRequestsPage)).not.toHaveProperty("html");
    const p = await seedSignedInParent();
    asParent(p.identity);
    await expect(runCheckAction()).rejects.toBeInstanceOf(AccessDenied);
    expect(await pageOutcome(CheckRequestsPage)).not.toHaveProperty("html");
    expect(stub.apiCalls()).toEqual([]);
    expect(await db.select().from(qboCheckRun)).toEqual([]);
  });

  it("can't be run against a connection whose roster holds ids QuickBooks never gives, as in the browser run", async () => {
    await checkCompany(stub);
    await db.update(qboCustomer).set({ qboId: "E2E-10" }).where(eq(qboCustomer.qboId, "10"));
    stub.calls.length = 0;
    asStaff(admin);
    expect(await runCheckAction()).toMatchObject({ ok: false });
    expect(stub.apiCalls()).toEqual([]);
    const html = await renderPage(CheckRequestsPage);
    expect(html).toContain("This connection can&#x27;t be checked");
    expect(html).not.toContain("Run the check</button>");
  });

  it("is said on the QuickBooks settings view and the Health page, with a link to the page when a request didn't answer as expected", async () => {
    await checkCompany(stub);
    asStaff(admin);
    expect(await renderPage(QuickBooksSettingsPage)).toContain("haven&#x27;t been checked against a company yet");
    stub.quirks.duplicateCode = "6000";
    await run();
    expect(await renderPage(QuickBooksSettingsPage)).toContain("Last checked against an Intuit sandbox company, reads and changes: 1 request didn&#x27;t answer as the portal expects.");
    const line = (await healthReport()).find((l) => l.key === "quickbooks")!;
    expect(line.state).toBe("attention");
    expect(line.notes).toContain("Last checked against an Intuit sandbox company, reads and changes: 1 request didn't answer as the portal expects.");
    expect(line.fix).toEqual({ href: "/staff/settings/quickbooks/check", label: "Check the portal's requests" });
    expect(line.times.find((t) => t.label === "Requests last checked")!.at).not.toBeNull();
    const html = await renderPage(CheckRequestsPage);
    expect(html).toContain("Not as expected");
    expect(html).toContain("This is a change to the portal for whoever maintains it");
    // The results are a table of its own, whose result words are kept whole (booster.css, .check-results).
    expect(html).toContain('class="table check-results"');
  });
});

/** Lists a customer the check made, in the stub and in its table, as a run would have. Returns its id. */
async function made(runId: string, kind: "family" | "student", s: QboStub, name: string, under?: string): Promise<string> {
  const id = String(80 + s.customers.length);
  s.customers.push({ Id: id, DisplayName: name, Active: true, SyncToken: "0", ...(under ? { ParentRef: { value: under }, Job: true } : {}) });
  await db.insert(qboCheckRecord).values({ runId, realmId: REALM, kind, qboId: id, name });
  return id;
}

/** Every write of the check, each naming these ids. */
function everyWrite(r: CheckRun, family: string, student: string, invoice: string): (() => Promise<unknown>)[] {
  const t = (kind: "family" | "student", qboId: string) => ({ kind, qboId });
  return [
    () => checkUpdateContact(r, t("family", family), "0", { phone: "555-0100" }),
    () => checkUpdateEmail(r, t("family", family), "0", "x@example.com"),
    () => checkRename(r, t("family", family), "0", "Booster Rocket check t other"),
    () => checkSetActive(r, t("student", student), "0", false),
    () => checkSetActive(r, t("family", family), "0", false),
    () => checkCreateInvoice(r, { studentQboId: student, itemQboId: "7", units: 1, unitCents: 100, marker: "00000000-0000-4000-8000-000000000000" }),
    () => checkVoidInvoice(r, { qboId: invoice }, "0"),
  ];
}

describe("the action's answer is a Done only when every request answered as expected", () => {
  it("needs attention, not Done, when a request didn't answer as the portal expects", async () => {
    await checkCompany(stub);
    stub.quirks.duplicateCode = "6000";
    asStaff(admin);
    expect(await runCheckAction()).toMatchObject({ ok: true, attention: true, message: expect.stringContaining("didn't answer as the portal expects") });
    stub.quirks.duplicateCode = "6240";
    expect(await runCheckAction()).toEqual({ ok: true, message: expect.stringContaining("every request answered as the portal expects") });
  });
});
