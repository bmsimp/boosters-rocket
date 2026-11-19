import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, buyout, familyMoney, qboConnection, qboCustomer, setting, type StoredInvoice } from "@/lib/db/schema";
import { setRosterSource } from "@/lib/roster/source";
import { calendarDayIn } from "@/lib/settings/club";
import PaymentsPage from "@/app/(parent)/payments/page";
import HomePage from "@/app/(parent)/page";
import { MoneyBox } from "@/app/(parent)/money-box";
import { buyoutTitleOf, loadMyBuyoutInvoices } from "@/lib/money/my-buyout-invoices";
import { BUYOUT_ITEM } from "../helpers/buyouts";
import { resetDb } from "../helpers/db";
import { ageMoney, CHENOWETH, connectCompany, invoiceQueries, moneyRow, RIVERA, stubInvoice as inv } from "../helpers/money";
import { FAMILY_A, FAMILY_B, identityAfterChoosingAgain, MONEY_REALM, moneyMarkers, seedFamilyMoney, seedSignedInParent, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedShape } from "../helpers/roster-cache";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const MINUTE = 60_000;
const NOT_CURRENT = "We couldn&#x27;t get the latest figures from QuickBooks just now. These are the last ones we have. Paying here is paused until we can. Need to pay sooner? Ask the treasurer.";
const NOTHING = "We can&#x27;t show what you owe right now. Please check back in a little while.";
const NOT_SET_UP = "Your family isn&#x27;t set up here yet";
const PAID_UP = "You&#x27;re all paid up. Thank you!";
const NOT_CONNECTED = "The club hasn&#x27;t connected your payments to the portal yet. Until then, the treasurer can tell you what you owe.";
const CREDIT = "The boosters may be holding a credit for you. The treasurer can tell you how it will be applied.";
/** Every Pay button on the page, as its opening tag. */
const pays = (html: string) => [...html.matchAll(/<a\b[^>]*class="btn[^"]*\bpay"[^>]*>/g)].map((m) => m[0]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The Riverquill family signed in, QuickBooks connected, and the family's customers known to the stub. */
async function riverquills(): Promise<SeededParent> {
  const r = await seedSignedInParent(RIVERA);
  await connectCompany(stub);
  stub.customers = [{ Id: RIVERA.family.qboId, DisplayName: RIVERA.family.name, BalanceWithJobs: 0 }];
  return r;
}
const [FAMILY, PARENT, STUDENT] = [RIVERA.family.qboId, RIVERA.parent.qboId, RIVERA.students[0]!.qboId];
const balanceWithJobs = (amount: number) => { stub.customers[0]!.BalanceWithJobs = amount; };

describe("the Payments page", () => {
  it("fresh figures: each open invoice, the total, a Pay link where there is a valid one, the as-of time, and what was paid", async () => {
    const { a } = await seedTwoFamilies();
    asParent(a.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain('<h1 class="page-title">Payments</h1>');
    expect(html).toContain("Alderquist Family</h2>");
    expect(html).toContain('<div class="amt num">$14,283.16</div>'); // 7,131.07 + 7,152.09: the paid invoice is not owed
    expect(html).toMatch(/Owed now\. From QuickBooks, as of <time dateTime="[^"]+"[^>]*>[^<]+<\/time>\./);
    expect(html).toContain('<span class="what">Invoice INV-ALDERQUIST-7101</span>');
    expect(html).toContain('<span class="amount num">$7,131.07</span>');
    expect(html).toContain('<span class="amount num">$7,152.09</span>');
    expect(html).toContain('<div class="sum"><span>Total</span><span class="num">$14,283.16</span></div>');
    expect(html).toMatch(/<span class="when">Invoice date <time dateTime="2026-10-01">2026-10-01<\/time><\/span>/);
    // The due date is on the page as it arrives, in words that depend on the club's day (the tests below).
    expect(html).toMatch(/<span class="when[^"]*">(Due|Was due) <time dateTime="2026-12-01">2026-12-01<\/time>[^<]*<\/span>/);
    // One Pay button: the invoice with a link. The other open invoice has none, and no error.
    const [pay, ...more] = pays(html);
    expect(more).toEqual([]);
    expect(pay).toContain('href="https://connect.intuit.com/t/scs-v1-alderquist-7101"');
    expect(pay).toContain('rel="noopener noreferrer"');
    expect(pay).toMatch(/referrerpolicy="no-referrer"/i);
    expect(pay).toContain('aria-label="Pay $7,131.07, invoice INV-ALDERQUIST-7101"');
    expect(pay).not.toMatch(/target=|aria-disabled/); // the same tab, and switched on
    expect(html).not.toContain("offline-note");
    expect(html).not.toContain(CREDIT);
    expect(html).toContain("An invoice with no Pay button can&#x27;t be paid online. The treasurer can tell you how to pay it.");
    // Paid in the last 12 months: listed with the word, not counted in the total.
    const paid = html.slice(html.indexOf("Paid in the last 12 months"));
    expect(paid).toContain('<span class="what">Invoice INV-ALDERQUIST-7103</span>');
    expect(paid).toContain('<span class="amount num">$7,173.11<span class="paid">Paid</span></span>');
    expect(pays(paid)).toEqual([]);
    expect(stub.calls).toHaveLength(0); // fresh: QuickBooks is not asked
    expect(await db.select().from(auditLog)).toHaveLength(0); // a parent viewing their own family is not audited
  });

  it("stale figures are read again from QuickBooks before the page shows them", async () => {
    const r = await riverquills();
    await seedFamilyMoney({ ...RIVERA, invoices: [{ number: "INV-OLD-STALE", cents: 99999 }] }, { readAt: new Date(Date.now() - 6 * MINUTE) });
    stub.invoices = [
      inv("1", FAMILY, { InvoiceLink: "https://connect.intuit.com/t/one", DueDate: "2026-12-20" }),
      inv("2", STUDENT, { Balance: 40.5, TotalAmt: 100, InvoiceLink: "https://connect.intuit.com/t/two", DueDate: "2026-12-05" }),
      inv("3", PARENT, { Balance: 0, TxnDate: new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10) }),
    ];
    balanceWithJobs(125.5);
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).not.toContain("INV-OLD-STALE");
    expect(html).not.toContain("$999.99");
    expect(html).toContain('<div class="amt num">$125.50</div>');
    expect(html).toContain('<span class="what">Invoice INV-2, Rafferty Riverquill</span>'); // raised on the student
    expect(html).toContain('<span class="what">Invoice INV-1</span>');                      // raised on the family itself
    expect(html).toContain('<span class="amount num">$40.50</span>');                        // what is still due, not the invoice's total
    expect(html).not.toContain("offline-note");
    // The soonest-due invoice comes first and has the filled button; the other is outlined.
    const [first, second] = pays(html);
    expect(first).toContain('class="btn pay"');
    expect(first).toContain('aria-label="Pay $40.50, invoice INV-2 for Rafferty Riverquill"');
    expect(second).toContain('class="btn btn-line pay"');
    expect(second).toContain('href="https://connect.intuit.com/t/one"');
    expect(html).toContain("Each invoice opens on QuickBooks&#x27; secure payment page.");
    expect(html).toContain('<span class="what">Invoice INV-3, Rosalind Riverquill</span>');
    expect(html).toContain('$85.00<span class="paid">Paid</span>');
    expect(invoiceQueries(stub)).toEqual([`select * from Invoice where CustomerRef in ('7010','7011','7012','7013') orderby Id startposition 1 maxresults 1000`]);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("QuickBooks down, with figures stored: the last figures, marked as not current, with Pay switched off in place", async () => {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY, { InvoiceLink: "https://connect.intuit.com/t/one" }), inv("2", STUDENT, { Balance: 100, TotalAmt: 100 })];
    asParent(r.identity);
    await renderPage(PaymentsPage);
    await ageMoney(FAMILY, 6 * MINUTE);
    stub.failNext = 2;
    const html = await renderPage(PaymentsPage);
    expect(html).toContain(`<p class="offline-note" role="status">${NOT_CURRENT}</p>`);
    expect(html).toContain('<div class="amt num">$185.00</div>');
    expect(html).toContain('<span class="amount num">$85.00</span>');
    expect(html).toContain('<div class="sum"><span>Total</span><span class="num">$185.00</span></div>');
    const [pay, ...more] = pays(html);
    expect(more).toEqual([]);
    expect(pay).toContain('aria-disabled="true"');
    expect(pay).toContain('aria-label="Pay $85.00, paused until the figures are up to date"');
    expect(pay).not.toContain("href=");
    expect(html).not.toContain("connect.intuit.com"); // the link itself is not sent while Pay is off
    expect(html).not.toMatch(/http_500|a message the portal must never store/);
    // The as-of time is still the time QuickBooks gave the figures, not now.
    const asOf = /as of <time dateTime="([^"]+)"/.exec(html)![1]!;
    expect(Date.now() - Date.parse(asOf)).toBeGreaterThan(5 * MINUTE);
  });

  // The figures are also "not current" for reasons that are not an outage and may last: the note says what is true of
  // all of them, and promises no time.
  it.each([
    ["only an Admin can mend the connection", "needs_admin", () => db.update(qboConnection).set({ lastError: "Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)", lastErrorAt: new Date() })],
    ["QuickBooks has been disconnected", "not_connected", () => db.update(qboConnection).set({ refreshTokenCiphertext: null, refreshTokenKeyId: null })],
  ])("figures that are not current because %s: no promise of when paying will be back, and no word of an outage", async (_what, code, breakIt) => {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY, { InvoiceLink: "https://connect.intuit.com/t/one" })];
    asParent(r.identity);
    await renderPage(PaymentsPage);
    await ageMoney(FAMILY, 6 * MINUTE);
    await breakIt();
    const html = await renderPage(PaymentsPage);
    expect((await moneyRow(FAMILY))!.failedCode).toBe(code);
    expect(html).toContain(`<p class="offline-note" role="status">${NOT_CURRENT}</p>`);
    expect(text(html)).not.toMatch(/shortly|\bsoon\b|can&#x27;t reach|offline|minutes/i);
    expect(html).toContain('<div class="amt num">$85.00</div>');
    const [pay] = pays(html);
    expect(pay).toContain('aria-disabled="true"');
    expect(pay).toContain('aria-label="Pay $85.00, paused until the figures are up to date"');
    expect(html).not.toContain("connect.intuit.com");
    expect(text(html)).not.toMatch(/invalid_grant|needs_admin|not_connected|Admin|disconnected/);
    expect(html).not.toContain(NOT_CONNECTED);
  });

  it("QuickBooks down, with nothing stored: a calm line, no figures, and no reason given", async () => {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY)];
    stub.failNext = 2;
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain(`<p class="help" role="status">${NOTHING}</p>`);
    expect(html).toContain("Riverquill Family</h2>");
    expect(html).not.toMatch(/\$\d/);
    expect(html).not.toContain("Paid in the last 12 months");
    expect(pays(html)).toEqual([]);
    expect(html).not.toContain("offline-note");
    expect(text(html)).not.toMatch(/error|failed|500|QuickBooks is|disconnected/i);
    expect(html).not.toContain(NOT_CONNECTED);
  });

  it("all paid: nothing owed, a thank-you, and no Pay button", async () => {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY, { Balance: 0, TxnDate: new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10), InvoiceLink: "https://connect.intuit.com/t/one" })];
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain('<div class="amt num">$0.00</div>');
    expect(html).toContain("Nothing owed. From QuickBooks, as of ");
    expect(html).toMatch(new RegExp(`<p class="paid-up"><svg[^>]*aria-hidden="true"[^>]*>.*?</svg>${PAID_UP}</p>`));
    expect(html).not.toContain('class="sum"');
    expect(pays(html)).toEqual([]);
    expect(html).toContain('$85.00<span class="paid">Paid</span>');
    expect(html).not.toContain(CREDIT);
  });

  it("a family with no invoices at all is all paid up, with nothing in the paid list", async () => {
    const r = await riverquills();
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain(PAID_UP);
    expect(html).toContain("No paid invoices from the last 12 months.");
    // A linked family that owes nothing reads its own words, never the unlinked family's.
    expect(html).not.toContain(NOT_CONNECTED);
  });

  it("the credit line: QuickBooks' balance is lower than the invoices add up to, and the figure stays the sum", async () => {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY), inv("2", STUDENT, { Balance: 100, TotalAmt: 100 })];
    balanceWithJobs(135);
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain(`<p class="help">${CREDIT}</p>`);
    expect(html).toContain('<div class="amt num">$185.00</div>');
    expect(html).not.toContain("$135.00");
    expect(html).not.toContain("$50.00");
    // Recorded for staff, by the system, not as something the parent did.
    // It names the app's own family, never the family's customer.
    expect((await db.select().from(auditLog)).map((row) => [row.door, row.action, row.targetType, row.targetId]))
      .toEqual([["system", "money.balance_mismatch", "family", String(await recordOfCustomer(FAMILY, "family"))]]);
    balanceWithJobs(250); // higher than the sum: nothing is said
    await ageMoney(FAMILY, 6 * MINUTE);
    expect(await renderPage(PaymentsPage)).not.toContain(CREDIT);
  });

  it("another company: figures stored from a different QuickBooks company than the roster cache are not shown", async () => {
    const r = await seedSignedInParent(RIVERA);
    await seedFamilyMoney({ ...RIVERA, invoices: [{ number: "INV-OTHER-COMPANY", cents: 4242, payLink: "https://connect.intuit.com/t/other-company" }] });
    // QuickBooks is disconnected, and the roster cache says it came from another company than the stored figures. The
    // roster read of that company brings the app's records into step with it, so the family has a record linked there,
    // and the row is that record's: the page finds the row, and only the company it names keeps it off the page.
    await db.transaction((tx) => setRosterSource(tx, "2222"));
    await syncAppRecords();
    const there = await recordOfCustomer(RIVERA.family.qboId, "family");
    await db.update(familyMoney).set({ familyId: there });
    expect((await db.select().from(familyMoney)).map((m) => m.realmId)).toEqual([MONEY_REALM]);
    // The sync left the first company's record inactive and moved the guardian row to the record linked in this one:
    // the session stored the first record, so the gate has it choose again, and it enters the family its row names now.
    const now = await identityAfterChoosingAgain(r.session.id);
    expect(String(now.familyId)).toBe(String(there));
    asParent(now);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain(NOTHING);
    expect(html).not.toContain(NOT_CONNECTED);
    expect(html).not.toMatch(/INV-OTHER-COMPANY|\$42\.42|other-company/);
    expect(stub.calls).toHaveLength(0);
    // The same row, named as the roster's company, is shown: it was the company that refused it, not a missing link.
    await db.update(familyMoney).set({ realmId: "2222" });
    expect(await renderPage(PaymentsPage)).toContain("INV-OTHER-COMPANY");
    expect(stub.calls).toHaveLength(0);
  });

  // Home shows the money box only for a family loadMyFamily() returns. Payments goes by the same rule, so the two
  // pages never disagree about whose money may be shown.
  const NO_MONEY = /class="box money"|class="box paid-box"|INV-|\$\d|connect\.intuit\.com|what you owe|\(deleted\)/i;
  it("shows no money for a family the roster may not show, as Home does: a family QuickBooks has made inactive", async () => {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY, { InvoiceLink: "https://connect.intuit.com/t/one" }), inv("2", FAMILY, { Balance: 0, TxnDate: new Date().toISOString().slice(0, 10) })];
    asParent(r.identity);
    expect(await renderPage(PaymentsPage)).toContain('<div class="amt num">$85.00</div>'); // stored, and fresh
    await db.update(qboCustomer).set({ active: false, displayName: "Riverquill Family (deleted)" }).where(eq(qboCustomer.qboId, FAMILY));
    await syncAppRecords(); // as the roster read that found it inactive leaves the records
    const asked = stub.calls.length;
    const html = await renderPage(PaymentsPage);
    expect(html).toContain('<h1 class="page-title">Payments</h1>');
    expect(html).toContain(NOT_SET_UP);
    expect(html).not.toMatch(NO_MONEY);
    expect(stub.calls).toHaveLength(asked);
    expect((await moneyRow(FAMILY))!.failedAt).toBeNull(); // the family's money was not even looked up
  });

  it("shows no figures while another company is connected than the one the roster cache came from, however fresh they are", async () => {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY, { InvoiceLink: "https://connect.intuit.com/t/one" })];
    asParent(r.identity);
    expect(await renderPage(PaymentsPage)).toContain('<div class="amt num">$85.00</div>');
    // The family is the app's own record, so the page is the family's; its money is QuickBooks', read through the
    // family's link, which answers nothing while another company is connected (clearing the old cache hasn't happened).
    const NO_FIGURES = /INV-|\$\d|connect\.intuit\.com|\(deleted\)/i;
    await db.update(qboConnection).set({ realmId: "2222" });
    const asked = stub.calls.length;
    const html = await renderPage(PaymentsPage);
    expect(html).toContain(NOTHING);
    expect(html).not.toContain(NOT_CONNECTED);
    expect(html).not.toMatch(NO_FIGURES);
    expect(stub.calls).toHaveLength(asked);
    // And the same when the shape names a customer type QuickBooks no longer has: whose invoices are whose can't be told.
    await db.update(qboConnection).set({ realmId: MONEY_REALM });
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "GONE", parentTypeId: "P" });
    const broken = await renderPage(PaymentsPage);
    expect(broken).toContain(NOTHING);
    expect(broken).not.toContain(NOT_CONNECTED);
    expect(broken).not.toMatch(NO_FIGURES);
    expect(stub.calls).toHaveLength(asked);
  });

  it("flat shape: the member's own invoices", async () => {
    const r = await riverquills();
    // The same customers under a flat shape: the "family" is a member, and only its own customer's invoices are its own.
    await seedShape({ kind: "flat", memberTypeIds: ["F"] });
    stub.invoices = [inv("1", FAMILY, { InvoiceLink: "https://connect.intuit.com/t/one" }), inv("2", STUDENT, { Balance: 100, TotalAmt: 100 })];
    balanceWithJobs(85);
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain('<div class="amt num">$85.00</div>');
    expect(html).toContain("Invoice INV-1");
    expect(html).not.toContain("INV-2");
    expect(invoiceQueries(stub)).toEqual([`select * from Invoice where CustomerRef = '7010' orderby Id startposition 1 maxresults 1000`]);
  });

  it("an invoice in another currency is shown in its own, and mixed currencies get no single total", async () => {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY, { CurrencyRef: { value: "CAD" } })];
    asParent(r.identity);
    expect(await renderPage(PaymentsPage)).toContain('<div class="amt num">CA$85.00</div>');
    stub.invoices.push(inv("2", STUDENT));
    await ageMoney(FAMILY, 6 * MINUTE);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain("These invoices are in more than one currency, so there is no single total.");
    expect(html).not.toContain('class="amt num"');
    expect(html).not.toContain('class="sum"');
    expect(html).toContain('<span class="amount num">CA$85.00</span>');
    expect(html).toContain('<span class="amount num">$85.00</span>');
  });
});

describe("a family with no link to the club's books", () => {
  /** The Riverquill family signed in, its record active, its family link deleted by hand (nothing brings it into step after). */
  async function unlinkedRiverquills(): Promise<SeededParent> {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY, { InvoiceLink: "https://connect.intuit.com/t/one" }), inv("2", FAMILY, { Balance: 0, TxnDate: new Date().toISOString().slice(0, 10) })];
    await db.delete(accountingLink).where(eq(accountingLink.familyId, r.identity.familyId));
    return r;
  }
  /** Anything of money: an amount, an invoice, a Pay button, the paid list or the not-current note. */
  const ANY_MONEY = /INV-|\$\d|connect\.intuit\.com|Paid in the last 12 months|offline-note|class="btn[^"]*\bpay"/;
  const BOX = `<section class="box money" aria-labelledby="money-h"><h2 id="money-h">What you owe</h2><p class="help" role="status">${NOT_CONNECTED}</p></section>`;
  /** The money box alone, from its opening tag to its own end (it holds no section of its own). */
  const moneyBox = (html: string) => {
    const start = html.indexOf('<section class="box money"');
    return start < 0 ? null : html.slice(start, html.indexOf("</section>", start) + "</section>".length);
  };

  it("Payments: the words in the money box, and nothing else of money; QuickBooks is asked nothing", async () => {
    const r = await unlinkedRiverquills();
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain('<h1 class="page-title">Payments</h1>');
    expect(moneyBox(html)).toBe(BOX);
    expect(html).not.toMatch(ANY_MONEY);
    expect(html).not.toContain("QuickBooks"); // Payments holds nothing but the money: nothing on it names QuickBooks
    expect(pays(html)).toEqual([]);
    expect(html).not.toContain(NOTHING);
    expect(stub.calls).toHaveLength(0);
    expect(await db.select().from(familyMoney)).toEqual([]);
  });

  it("Home: the same words where the money box stands, with no way to Payments from it and no amount", async () => {
    const r = await unlinkedRiverquills();
    asParent(r.identity);
    const html = await renderPage(HomePage);
    expect(moneyBox(html)).toBe(BOX);
    expect(html).not.toMatch(ANY_MONEY);
    expect(html).not.toContain("See your payments");
    expect(stub.calls).toHaveLength(0);
    expect(await db.select().from(familyMoney)).toEqual([]);
  });

  it("a club whose roster names no company: Home and Payments read the same words", async () => {
    const r = await seedSignedInParent(RIVERA);
    // As a club that has never read a roster from QuickBooks: no company named, nothing connected, no link of the family's.
    await db.delete(setting).where(eq(setting.key, "roster.source"));
    await db.delete(accountingLink).where(eq(accountingLink.familyId, r.identity.familyId));
    asParent(r.identity);
    for (const page of [PaymentsPage, HomePage]) {
      const html = await renderPage(page);
      expect(moneyBox(html)).toBe(BOX);
      expect(html).not.toMatch(ANY_MONEY);
    }
    expect(stub.calls).toHaveLength(0);
  });
});

describe("QuickBooks text and links on the Payments page", () => {
  const HOSTILE = `<img src=x onerror=alert(1)>"><script>a()</script>`; // 50 characters: as long as a number is kept

  it("renders a hostile invoice number and customer name as text, in the row and in the Pay button's name", async () => {
    const r = await riverquills();
    await db.update(qboCustomer).set({ displayName: `<b onmouseover=alert(3)>Rafferty</b>` }).where(eq(qboCustomer.qboId, STUDENT));
    stub.invoices = [inv("1", STUDENT, { DocNumber: HOSTILE, InvoiceLink: "https://connect.intuit.com/t/one" }), inv("2", FAMILY, { DocNumber: HOSTILE, Balance: 0, TxnDate: new Date().toISOString().slice(0, 10) })];
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).not.toMatch(/<img|<script|<b /i);
    expect(html).not.toContain('onerror=alert(1)>"');
    expect(html).toContain("Invoice &lt;img src=x onerror=alert(1)&gt;&quot;&gt;&lt;script&gt;a()&lt;/script&gt;, &lt;b onmouseover=alert(3)&gt;Rafferty&lt;/b&gt;");
    const [pay] = pays(html);
    expect(pay).toContain('aria-label="Pay $85.00, invoice &lt;img src=x onerror=alert(1)&gt;&quot;&gt;&lt;script&gt;a()&lt;/script&gt; for &lt;b onmouseover=alert(3)&gt;Rafferty&lt;/b&gt;"');
    expect(pay).toContain('href="https://connect.intuit.com/t/one"');
  });

  it.each([
    ["javascript:", "javascript:alert(document.cookie)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["plain http", "http://connect.intuit.com/t/one"],
    ["another host", "https://pay.evil.example/intuit.com/t/one"],
    ["a host that only looks like Intuit", "https://connect.intuit.com.evil.example/t/one"],
    ["a user name", "https://connect.intuit.com@evil.example/t/one"],
  ])("gives no button and no error for a pay link that is %s", async (_what, link) => {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY, { InvoiceLink: link })];
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(pays(html)).toEqual([]);
    expect(html).not.toMatch(/javascript:|data:text|evil\.example|http:\/\/connect/);
    expect(html).toContain('<span class="amount num">$85.00</span>'); // the invoice itself is still shown
    expect((await moneyRow(FAMILY))!.invoices![0]!.payLink).toBeNull(); // and the link was never stored
  });

  it("checks a stored pay link again before showing it: a bad one in the table gets no button", async () => {
    const r = await riverquills();
    await seedFamilyMoney({ ...RIVERA, invoices: [{ number: "INV-TAMPERED", cents: 8500, payLink: "javascript:alert(1)" }, { number: "INV-ELSEWHERE", cents: 100, payLink: "https://evil.example/pay" }] });
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain("INV-TAMPERED");
    expect(pays(html)).toEqual([]);
    expect(html).not.toMatch(/javascript:|evil\.example/);
  });

  it("is kind about money: plain amounts and dates, no alarm words", async () => {
    const r = await riverquills();
    stub.invoices = [inv("1", FAMILY, { DueDate: "2020-01-15" }), inv("2", STUDENT, { DueDate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) })];
    asParent(r.identity);
    const words = text(await renderPage(PaymentsPage));
    expect(words).not.toMatch(/overdue|past due|delinquent|urgent|immediately|action required|warning|penalt|late fee|!!|\bLATE\b|\bDUE NOW\b/i);
    expect(words).toContain("Need more time? Ask the treasurer. They're happy to work something out.".replace("'", "&#x27;"));
  });
});

describe("a due date is said against the club's own day", () => {
  const dueLine = (html: string, due: string) => new RegExp(`<span class="(when[^"]*)">([^<]*)<time dateTime="${due}">[^<]*</time>([^<]*)</span>`).exec(html)?.slice(1);
  const setZone = (timeZone: string) => db.insert(setting).values({ key: "club", value: { timeZone } }).onConflictDoUpdate({ target: setting.key, set: { value: { timeZone } } });

  it("at the day boundary: due today in the club's zone, and already past in a club a day ahead", async () => {
    const r = await riverquills();
    asParent(r.identity);
    // UTC+14 and UTC-11 never share a calendar day. The invoice is due on the western club's today.
    const now = new Date();
    const eastern = calendarDayIn("Pacific/Kiritimati", now), western = calendarDayIn("Pacific/Pago_Pago", now);
    expect(eastern > western).toBe(true);
    stub.invoices = [inv("1", FAMILY, { DueDate: western })];

    await setZone("Pacific/Pago_Pago");
    expect(dueLine(await renderPage(PaymentsPage), western)).toEqual(["when soon", "Due ", ", today"]);
    expect(dueLine(await renderPage(() => MoneyBox({ ctx: r.identity })), western)).toEqual(["when soon", "Due ", ", today"]);

    // The same invoice, the same instant, the same server: only the club's zone differs, and there the day has passed.
    await setZone("Pacific/Kiritimati");
    expect(dueLine(await renderPage(PaymentsPage), western)).toEqual(["when late", "Was due ", ""]);
    expect(dueLine(await renderPage(() => MoneyBox({ ctx: r.identity })), western)).toEqual(["when late", "Was due ", ""]);
  });

  it("due tomorrow, due in 14 days and due in 15, counted from the club's today", async () => {
    const r = await riverquills();
    asParent(r.identity);
    await setZone("Pacific/Kiritimati");
    const today = calendarDayIn("Pacific/Kiritimati");
    const plus = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    stub.invoices = [inv("1", FAMILY, { DueDate: plus(1) }), inv("2", FAMILY, { DueDate: plus(14) }), inv("3", STUDENT, { DueDate: plus(15) }), inv("4", PARENT, { DueDate: plus(-1) })];
    const html = await renderPage(PaymentsPage);
    expect(dueLine(html, plus(1))).toEqual(["when soon", "Due ", ", tomorrow"]);
    expect(dueLine(html, plus(14))).toEqual(["when soon", "Due ", ", in 14 days"]);
    expect(dueLine(html, plus(15))).toEqual(["when", "Due ", ""]);
    expect(dueLine(html, plus(-1))).toEqual(["when late", "Was due ", ""]);
  });
});

describe("the money box for Home", () => {
  it("shows the same figures for the signed-in family, with the way to the Payments page", async () => {
    const { a, b } = await seedTwoFamilies();
    const html = await renderPage(() => MoneyBox({ ctx: a.identity }));
    expect(html).toMatch(/^<section class="box money" aria-labelledby="money-h"><h2 id="money-h">Alderquist Family<\/h2>/);
    for (const mine of moneyMarkers(FAMILY_A).filter((m) => !m.includes("7103") && m !== "$7,173.11")) expect(html).toContain(mine);
    expect(html).not.toMatch(/INV-ALDERQUIST-7103|\$7,173\.11|Paid in the last/); // the paid list is on the Payments page
    expect(html).toMatch(/<a class="btn btn-line" href="\/payments">See your payments<\/a>/);
    const theirs = b.markers.filter((m) => html.toLowerCase().includes(m.toLowerCase()));
    expect(theirs).toEqual([]);
  });

  it("with nothing to show, says so calmly and still leads to the Payments page", async () => {
    const r = await seedSignedInParent(RIVERA);
    const html = await renderPage(() => MoneyBox({ ctx: r.identity }));
    expect(html).toContain(NOTHING);
    expect(html).toContain('href="/payments"');
  });

  // The box asks loadMyFamily() nothing itself: what keeps it safe is that loadFamilyMoney() shows nothing of a family
  // whose own record is inactive, however fresh its stored figures.
  it("shows no money for a family whose record is inactive, and reads and writes nothing for it", async () => {
    const r = await seedSignedInParent(RIVERA);
    await seedFamilyMoney({ ...RIVERA, invoices: [{ number: "INV-STILL-STORED", cents: 4242 }] });
    expect(await renderPage(() => MoneyBox({ ctx: r.identity }))).toContain("INV-STILL-STORED"); // fresh, and shown
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, FAMILY));
    await syncAppRecords(); // as the roster read that found it inactive leaves the records
    const before = await db.select().from(familyMoney);
    const html = await renderPage(() => MoneyBox({ ctx: r.identity }));
    expect(html).toContain(NOTHING);
    expect(html).not.toMatch(/INV-STILL-STORED|\$42\.42/);
    expect(await db.select().from(familyMoney)).toEqual(before);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("one family never sees another's money", () => {
  it("family A's page holds none of family B's invoices when both are in QuickBooks, and each family's read asks only for its own customers", async () => {
    const r = await riverquills();
    const c = await seedSignedInParent(CHENOWETH);
    stub.customers.push({ Id: CHENOWETH.family.qboId, DisplayName: CHENOWETH.family.name, BalanceWithJobs: 512.34 });
    balanceWithJobs(85);
    stub.invoices = [
      inv("1", FAMILY, { DocNumber: "INV-RIVERQUILL-ONLY" }),
      inv("2", CHENOWETH.family.qboId, { DocNumber: "INV-CHENOWETH-ONLY", Balance: 500, TotalAmt: 500, InvoiceLink: "https://connect.intuit.com/t/chenoweth-only" }),
      inv("3", CHENOWETH.students[0]!.qboId, { DocNumber: "INV-CASPIAN-ONLY", Balance: 12.34 }),
    ];
    const THEIRS = /CHENOWETH|CASPIAN|Cordelia|Clementine|\$500\.00|\$12\.34|\$512\.34|chenoweth-only|8010|8011|8012|8013/i;
    asParent(r.identity);
    const mine = await renderPage(PaymentsPage);
    expect(mine).toContain("INV-RIVERQUILL-ONLY");
    expect(mine).not.toMatch(THEIRS);
    expect(await renderPage(() => MoneyBox({ ctx: r.identity }))).not.toMatch(THEIRS);
    asParent(c.identity);
    const other = await renderPage(PaymentsPage);
    expect(other).toContain("INV-CHENOWETH-ONLY");
    expect(other).toContain('<div class="amt num">$512.34</div>');
    expect(other).not.toMatch(/RIVERQUILL|Rosalind|Rafferty|Romilly|\$85\.00|7010|7011|7012|7013/i);
    expect(invoiceQueries(stub)).toEqual([
      "select * from Invoice where CustomerRef in ('7010','7011','7012','7013') orderby Id startposition 1 maxresults 1000",
      "select * from Invoice where CustomerRef in ('8010','8011','8012','8013') orderby Id startposition 1 maxresults 1000",
    ]);
    // Each family's row holds its own invoices only.
    expect((await moneyRow(FAMILY))!.invoices!.map((i) => i.number)).toEqual(["INV-RIVERQUILL-ONLY"]);
  });

  it("nothing in the request chooses the family: the other family's ids in the address change nothing and are asked of nobody", async () => {
    const { a, b } = await seedTwoFamilies();
    const before = await db.select().from(familyMoney);
    asParent(a.identity);
    const B = FAMILY_B.family.qboId;
    for (const searchParams of [{ family: B }, { familyQboId: B, customer: B, customerId: FAMILY_B.students[0]!.qboId }, { id: B, invoice: "9001", realmId: "2222" }, { family: [B, B] }]) {
      const html = await renderPage(PaymentsPage, { searchParams, params: { id: B, family: B } });
      expect(html).toContain("INV-ALDERQUIST-7101");
      const leaked = b.markers.filter((m) => html.toLowerCase().includes(m.toLowerCase()));
      expect(leaked).toEqual([]);
    }
    expect(await db.select().from(familyMoney)).toEqual(before); // and nothing was changed
    expect(stub.calls).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("a session for one family is never shown the row of another, even when its own has nothing", async () => {
    const r = await seedSignedInParent(RIVERA);
    await seedSignedInParent(FAMILY_B);
    await seedFamilyMoney(FAMILY_B);
    await db.delete(qboConnection);
    asParent(r.identity);
    const html = await renderPage(PaymentsPage);
    expect(html).toContain(NOTHING);
    for (const theirs of moneyMarkers(FAMILY_B)) expect(html).not.toContain(theirs);
    expect((await db.select().from(setting).where(eq(setting.key, "roster.source"))).length).toBe(1);
  });
});

describe("a buy-out's invoice on Payments", () => {
  const onA = (qboId: string, balanceCents: number): StoredInvoice => ({ qboId, number: `BUY-${qboId}`, customerQboId: FAMILY_A.family.qboId, forName: null, date: "2026-10-02",
    dueDate: balanceCents ? "2026-12-02" : null, totalCents: 7438, balanceCents, currency: "USD", payLink: null, itemQboIds: [BUYOUT_ITEM] });
  /** A's figures with two more invoices: its own buy-out's (9174, open) and one that carries B's buy-out's invoice id (9285, paid). */
  async function withBuyoutInvoices() {
    const { a, b } = await seedTwoFamilies();
    const familyA = await recordOfCustomer(FAMILY_A.family.qboId, "family");
    const [row] = await db.select().from(familyMoney).where(eq(familyMoney.familyId, familyA));
    await db.update(familyMoney).set({ invoices: [onA("9174", 7438), ...row!.invoices!, onA("9285", 0)], totalCents: row!.totalCents! + 7438, balanceWithJobsCents: null })
      .where(eq(familyMoney.familyId, familyA));
    return { a, b };
  }

  it("is named as the family's own volunteering buy-out, found by the family's own buy-outs alone", async () => {
    const { a, b } = await withBuyoutInvoices();
    asParent(a.identity);
    const html = text(await renderPage(PaymentsPage));
    expect(html).toContain("Invoice BUY-9174 Paying instead of volunteering: Concession stand shifts QA74 Invoice date");
    expect(html.match(/Paying instead of volunteering/g)).toHaveLength(1);
    // An invoice id of B's buy-out, even among A's own invoices, names nothing of B's.
    expect(html).toContain("Invoice BUY-9285 Invoice date");
    for (const theirs of b.buyout!.markers) expect(html).not.toContain(theirs);

    asParent(b.identity);
    const theirs = text(await renderPage(PaymentsPage));
    expect(theirs).not.toContain("Paying instead of volunteering");
    for (const mine of a.buyout!.markers) expect(theirs).not.toContain(mine);
  });

  it("is named so in Home's money box too, and only to the family that chose it", async () => {
    const { a, b } = await withBuyoutInvoices();
    asParent(a.identity);
    expect(text(await renderPage(HomePage))).toContain("Paying instead of volunteering: Concession stand shifts QA74");
    asParent(b.identity);
    const theirs = text(await renderPage(HomePage));
    expect(theirs).not.toContain("Paying instead of volunteering");
    for (const mine of a.buyout!.markers) expect(theirs).not.toContain(mine);
  });

  it("names a buy-out only on the customer the portal raised it on, and only in the company the roster came from", async () => {
    await withBuyoutInvoices();
    const familyA = await recordOfCustomer(FAMILY_A.family.qboId, "family");
    const mine = await loadMyBuyoutInvoices(familyA);
    expect([...mine.keys()]).toEqual(["9174"]);
    expect(buyoutTitleOf(mine, { qboId: "9174", customerQboId: FAMILY_A.family.qboId })).toBe("Concession stand shifts QA74");
    expect(buyoutTitleOf(mine, { qboId: "9174", customerQboId: FAMILY_A.students[0]!.qboId })).toBeNull();
    await db.transaction((tx) => setRosterSource(tx, "another-company"));
    expect(await loadMyBuyoutInvoices(familyA)).toEqual(new Map());
  });

  it("names it only while the buy-out is live: one staff closed after it was paid (refunded in QuickBooks) is an invoice like any other", async () => {
    const { a } = await withBuyoutInvoices();
    await db.update(buyout).set({ state: "voided", endReason: "closed_by_staff" }).where(eq(buyout.familyId, await recordOfCustomer(FAMILY_A.family.qboId, "family")));
    expect(await loadMyBuyoutInvoices(a.identity.familyId)).toEqual(new Map());
    asParent(a.identity);
    const html = text(await renderPage(PaymentsPage));
    expect(html).toContain("Invoice BUY-9174 Invoice date");
    expect(html).not.toContain("Paying instead of volunteering");
  });
});
