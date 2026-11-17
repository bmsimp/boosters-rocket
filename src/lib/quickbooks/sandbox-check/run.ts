import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCheckRecord, qboCheckRun, type CheckLearned, type CheckOutcome, type CheckResult } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { QboError } from "@/lib/quickbooks/endpoints";
import {
  CUSTOMER_UPDATE, EMAIL_UPDATE, INVOICE_INCLUDE, INVOICE_QUERIES, INVOICE_WRITES, isQboId,
  qboCustomerById, qboCustomerTypes, qboGet, qboInvoices, qboItems, qboQueryAll, type CustomerAddress,
} from "@/lib/quickbooks/client";
import { getShape, ROSTER_LOCK } from "@/lib/roster/shape";
import { clubToday } from "@/lib/settings/club";
import { CONTACT_FIELDS } from "@/lib/parents/contact-fields";
import { safePayLink } from "@/lib/money/pay-link";
import { toCents } from "@/lib/money/cents";
import { allAsExpected, EXPECTATIONS, type ExpectationKey } from "./expectations";
import { checkReadiness } from "./view";
import {
  checkCreateCustomer, checkCreateInvoice, checkMove, checkRename, checkSetActive, checkUpdateContact, checkUpdateEmail, checkVoidInvoice,
  noteCloseFailed, recordClosed, recordMade, type CheckKind, type CheckRun,
} from "./writes";

/**
 * The check of the portal's own QuickBooks requests (roadmap step 7): every request the portal sends QuickBooks, sent
 * once, with what QuickBooks answered compared with what the portal expects (./expectations.ts).
 *
 * The reads run against the connected company, sandbox or production, and keep only what was learned: counts, which
 * form worked, field names, host names. Never a name, an amount or an address. The writes run only when the run was
 * asked for them (the action asks only for a sandbox) and the connection is an Intuit sandbox at the moment each is
 * sent (./writes.ts), and only on records this run made: two families, a student and a parent named "Booster Rocket
 * check <date> <tag> ..." with addresses at example.com, which can receive no mail, and one small invoice. At the end
 * every one is made inactive and the invoice voided (QuickBooks deletes no customer). While the writes run the check
 * holds the roster lock shared, so no roster refresh reads its records while they are active; once they are inactive,
 * no refresh gives them a sign-in. A run cut off part way leaves its records listed, and the next run makes them
 * inactive first.
 *
 * One run at a time (CHECK_LOCK). The run's row and the records are written as it goes, so whatever happens, what it
 * made stays listed. Started only from src/app/staff/(app)/settings/quickbooks/check/actions.ts.
 */
export const CHECK_LOCK = 7461007;
/** How long a whole run may take before it stops. */
const RUN_DEADLINE_MS = 5 * 60_000;
/** The amount of the check's invoice, in cents: one unit at $1.00. */
const CHECK_UNIT_CENTS = 100;

export type CheckAsk = { staffUserId: string; label: string | null; ip: string | null; writes: boolean };
export type CheckAnswer = { ok: true; runId: string; outcome: "passed" | "not_as_expected" | "stopped" } | { ok: false; reason: "running" | "not_ready" };

type Raw = Record<string, unknown>;
const isRow = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const ref = (v: unknown): string | null => { const id = (v as { value?: unknown } | null | undefined)?.value; return typeof id === "string" ? id : null; };
const tokenOf = (c: Raw | null): string => (typeof c?.SyncToken === "string" && /^\d{1,20}$/.test(c.SyncToken) ? c.SyncToken : "0");
const idOf = (c: Raw | null): string | null => (typeof c?.Id === "string" && isQboId(c.Id) ? c.Id : null);
const phoneOf = (c: Raw | null) => { const p = (c?.PrimaryPhone as { FreeFormNumber?: unknown } | undefined)?.FreeFormNumber; return typeof p === "string" ? p : ""; };
const emailOf = (c: Raw | null) => { const a = (c?.PrimaryEmailAddr as { Address?: unknown } | undefined)?.Address; return typeof a === "string" ? a : ""; };
const ADDRESS_PARTS = ["Line1", "Line2", "City", "CountrySubDivisionCode", "PostalCode", "Country"] as const;
const addressOf = (c: Raw | null) => { const a = isRow(c?.BillAddr) ? c.BillAddr : {}; return Object.fromEntries(ADDRESS_PARTS.map((k) => [k, typeof a[k] === "string" ? a[k] : ""])) as Record<(typeof ADDRESS_PARTS)[number], string>; };
const older = (token: string) => String(Math.max(0, Number(token) - 1));
const isDay = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** A host name as the check may keep it: lower-case letters, digits, dots and hyphens; anything else is "another host". */
const hostOf = (link: string): string => { try { const h = new URL(link).hostname.toLowerCase(); return /^[a-z0-9.-]{1,100}$/.test(h) ? h : "another host"; } catch { return "not an address"; } };

/** The fields compared before and after a change, to see that nothing else changed. */
const WATCHED = ["DisplayName", "GivenName", "FamilyName", "PrimaryEmailAddr", "PrimaryPhone", "BillAddr", "ParentRef", "CustomerTypeRef", "Active", "Job", "BillWithParent"] as const;
/** The fields of `before` that `after` holds differently, but for those the change was meant to touch. */
function differences(before: Raw | null, after: Raw | null, meant: string[]): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return WATCHED.filter((f) => !meant.includes(f) && !same(before?.[f], after?.[f]));
}

/** A failure that ends the run: nothing more can be sent, or should be. */
class Stopped extends Error { constructor(readonly code: string) { super(code); } }
const STOPS: Record<string, string> = {
  unreachable: "unreachable", timeout: "timeout", not_connected: "not_connected", other_company: "other_company", not_sandbox: "not_sandbox", needs_admin: "needs_admin",
  token_unreachable: "unreachable", token_timeout: "timeout", token_not_connected: "not_connected", token_invalid_grant: "needs_admin", token_unreadable: "needs_admin", token_needs_admin: "needs_admin",
};
const stopFor = (e: unknown): string | null => (e instanceof QboError ? STOPS[e.code] ?? null : null);
const codeOf = (e: unknown): string => (e instanceof QboError || e instanceof Stopped ? e.code.slice(0, 60) : "unexpected");
const isValidation = (code: string) => { const m = /^fault_(\d+)$/.exec(code); return m !== null && CUSTOMER_UPDATE.faults.validation.test(m[1]!); };

/** Runs the whole check: the reads, then (for a sandbox company) the writes. */
export async function runSandboxCheck(ask: CheckAsk): Promise<CheckAnswer> {
  const ready = await checkReadiness();
  if (!ready.ok) return { ok: false, reason: "not_ready" };
  const actor: Actor = { door: "staff", id: ask.staffUserId, label: ask.label };
  return db.transaction(async (lockTx): Promise<CheckAnswer> => {
    const [got] = Array.from(await lockTx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(${CHECK_LOCK}) as locked`));
    if (!got?.locked) return { ok: false, reason: "running" };
    await markCutOff(actor, ask.ip);
    const tag = `${await clubToday()} ${randomBytes(2).toString("hex")}`;
    const [row] = await db.insert(qboCheckRun).values({ realmId: ready.realmId, environment: ready.environment, writes: ask.writes, tag, startedBy: ask.staffUserId, startedByLabel: ask.label }).returning();
    await writeAudit({ actor, action: "quickbooks.check.start", targetType: "qbo_check_run", targetId: row!.id, after: { environment: ready.environment, writes: ask.writes, tag }, ip: ask.ip });
    const run: CheckRun = { id: row!.id, realmId: ready.realmId, actor, ip: ask.ip, signal: AbortSignal.timeout(RUN_DEADLINE_MS) };
    const results = new Map<string, CheckResult>();
    let stopCode: string | null = null;
    try {
      await new Check(run, tag, results, ask.writes && ready.environment === "sandbox", async () => {
        // Held to the end of the run: no roster refresh reads the check's records while they are active.
        const [shared] = Array.from(await lockTx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock_shared(${ROSTER_LOCK}) as locked`));
        return shared?.locked === true;
      }).all();
    } catch (e) {
      stopCode = e instanceof Stopped ? e.code : "unexpected";
    }
    const ordered: CheckResult[] = EXPECTATIONS.map((x) => results.get(x.key) ?? { key: x.key, outcome: "not_run", code: ready.environment === "production" && x.group === "writes" ? "production" : "stopped", learned: {} });
    const outcome = stopCode ? "stopped" : allAsExpected(ordered) ? "passed" : "not_as_expected";
    const open = await db.select({ id: qboCheckRecord.id }).from(qboCheckRecord).where(and(eq(qboCheckRecord.runId, run.id), isNull(qboCheckRecord.closedAt)));
    // What QuickBooks made: a create it refused is listed with no id, and closed.
    const made = await db.select({ id: qboCheckRecord.id }).from(qboCheckRecord).where(and(eq(qboCheckRecord.runId, run.id), isNotNull(qboCheckRecord.qboId)));
    await db.transaction(async (tx) => {
      await tx.update(qboCheckRun).set({ outcome, stopCode, results: ordered, finishedAt: new Date() }).where(eq(qboCheckRun.id, run.id));
      const count = (o: CheckOutcome) => ordered.filter((r) => r.outcome === o).length;
      await writeAudit({ actor, action: "quickbooks.check.end", targetType: "qbo_check_run", targetId: run.id, ip: ask.ip,
        after: { outcome, stopCode, asExpected: count("as_expected"), notAsExpected: count("not_as_expected"), learned: count("learned"), notRun: count("not_run"), made: made.length, open: open.length } }, tx);
    });
    return { ok: true, runId: run.id, outcome };
  });
}

/** Runs left unfinished: the server stopped part way. The caller holds CHECK_LOCK, so none of them is still running. */
async function markCutOff(actor: Actor, ip: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const cut = await tx.update(qboCheckRun).set({ outcome: "cut_off", stopCode: "cut_off", finishedAt: new Date() }).where(isNull(qboCheckRun.outcome)).returning({ id: qboCheckRun.id });
    for (const c of cut) await writeAudit({ actor, action: "quickbooks.check.cut_off", targetType: "qbo_check_run", targetId: c.id, ip }, tx);
  });
}

type Made = { id: string; token: string; name: string };

class Check {
  private customers: Raw[] = [];
  private types: Raw[] = [];
  private items: Raw[] = [];
  private invoices: Raw[] = [];
  constructor(private run: CheckRun, private tag: string, private results: Map<string, CheckResult>, private writes: boolean, private lockRoster: () => Promise<boolean>) {}

  private set(key: ExpectationKey, outcome: CheckOutcome, learned: CheckLearned = {}, code: string | null = null) {
    this.results.set(key, { key, outcome, code, learned });
  }
  /** Runs one step: a stopping failure ends the run, any other failure is that request's result. */
  private async step(key: ExpectationKey, needs: unknown[], fn: () => Promise<void>): Promise<void> {
    if (needs.some((n) => !n)) return this.set(key, "not_run", {}, "needs_earlier");
    try { await fn(); } catch (e) {
      const stop = stopFor(e);
      if (stop) { this.set(key, "not_run", {}, "stopped"); throw new Stopped(stop); }
      if (!(e instanceof QboError)) throw e;
      this.set(key, "not_as_expected", {}, codeOf(e));
    }
  }
  /** What QuickBooks answered a change the check expects it may refuse: its code, or "accepted". */
  private async answerTo(fn: () => Promise<unknown>): Promise<string> {
    try { await fn(); return "accepted"; } catch (e) {
      if (stopFor(e)) throw e;
      if (e instanceof QboError) return codeOf(e);
      throw e;
    }
  }
  // Every read names the company the run started with: when another is connected, nothing is asked of it.
  private read = async (id: string): Promise<Raw | null> => qboCustomerById(id, { signal: this.run.signal, realmId: this.run.realmId });
  private get = (params: Record<string, string>) => qboGet("query", params, { signal: this.run.signal, realmId: this.run.realmId });

  async all(): Promise<void> {
    await this.reads();
    if (!this.writes) return;
    if (!(await this.lockRoster())) {
      for (const x of EXPECTATIONS) if (x.group === "writes") this.set(x.key, "not_run", {}, "roster_busy");
      return;
    }
    await cleanUpEarlier(this.run, this.customers);
    try { await this.writeSteps(); } finally { await this.closeAll(); }
  }

  /* ---- Reads ---- */

  private async reads(): Promise<void> {
    await this.step("customer_types", [true], async () => {
      const types = this.types = await qboCustomerTypes();
      await stillTheCompany(this.run);
      const ok = types.every((t) => typeof t.Id === "string" && typeof t.Name === "string");
      this.set("customer_types", ok ? "as_expected" : "not_as_expected", { count: types.length });
    });
    await this.step("customers", [true], async () => {
      this.customers = await qboQueryAll("Customer", "Active in (true, false)");
      await stillTheCompany(this.run);
      const ok = this.customers.every((c) => typeof c.Id === "string" && typeof c.DisplayName === "string" && typeof c.Active === "boolean");
      this.set("customers", ok ? "as_expected" : "not_as_expected", { count: this.customers.length, inactive: this.customers.filter((c) => c.Active === false).length });
    });
    await this.step("items", [true], async () => {
      this.items = await qboItems({ signal: this.run.signal, realmId: this.run.realmId });
      const ok = this.items.every((i) => typeof i.Id === "string" && typeof i.Name === "string" && typeof i.Type === "string" && typeof i.Active === "boolean");
      const types = [...new Set(this.items.map((i) => i.Type).filter((t): t is string => typeof t === "string" && /^[A-Za-z]{1,30}$/.test(t)))].sort().slice(0, 8);
      this.set("items", ok ? "as_expected" : "not_as_expected", { count: this.items.length, inactive: this.items.filter((i) => i.Active === false).length, types });
    });

    // Whose invoices to read: a few customers that owe something, else a few active ones. Ids only; nothing about them is kept.
    const active = this.customers.filter((c) => c.Active !== false && idOf(c));
    const owing = active.filter((c) => typeof c.Balance === "number" && c.Balance > 0);
    const asked = (owing.length ? owing : active).slice(0, 3).map((c) => idOf(c)!);
    if (!asked.length) for (const k of ["invoices_list_form", "invoices_one_form", "invoice_fields", "invoice_items", "pay_links"] as const) this.set(k, "not_run", {}, "no_customers");
    else {
      await this.step("invoices_list_form", [true], async () => {
        let body: unknown;
        try { body = await this.get({ query: INVOICE_QUERIES.inForm(asked, 1), include: INVOICE_INCLUDE }); } catch (e) {
          if (e instanceof QboError && e.code === "http_400") return this.set("invoices_list_form", "as_expected", { form: "one_at_a_time", refusal: e.code });
          throw e;
        }
        if (isRow(body) && ("Fault" in body || "fault" in body)) return this.set("invoices_list_form", "as_expected", { form: "one_at_a_time", refusal: "fault" });
        const rows = invoiceRows(body);
        if (rows === null) return this.set("invoices_list_form", "not_as_expected", {}, "bad_answer");
        const others = rows.filter((i) => !asked.includes(ref(i.CustomerRef) ?? "")).length;
        this.invoices.push(...rows.filter((i) => asked.includes(ref(i.CustomerRef) ?? "")));
        this.set("invoices_list_form", others ? "not_as_expected" : "as_expected", others ? { form: "leaks", others } : { form: "list", invoices: rows.length, asked: asked.length });
      });
      await this.step("invoices_one_form", [true], async () => {
        let count = 0, others = 0;
        for (const id of asked) {
          const body = await this.get({ query: INVOICE_QUERIES.oneForm(id, 1), include: INVOICE_INCLUDE });
          const rows = invoiceRows(body);
          if (rows === null) return this.set("invoices_one_form", "not_as_expected", {}, isRow(body) && "Fault" in body ? "fault" : "bad_answer");
          count += rows.length;
          others += rows.filter((i) => ref(i.CustomerRef) !== id).length;
          for (const r of rows) if (ref(r.CustomerRef) === id && !this.invoices.some((i) => i.Id === r.Id)) this.invoices.push(r);
        }
        this.set("invoices_one_form", others ? "not_as_expected" : "as_expected", { invoices: count, others });
      });
      this.judgeInvoices(this.invoices);
    }

    await this.step("empty_answer", [true], async () => {
      // An id no customer has: the request matches nothing. It names no record.
      const top = this.customers.reduce((m, c) => { const id = idOf(c); return id && BigInt(id) > m ? BigInt(id) : m; }, BigInt(0));
      const nobody = String(top + BigInt(7_000_003)).slice(0, 19);
      const body = await this.get({ query: INVOICE_QUERIES.oneForm(nobody, 1), include: INVOICE_INCLUDE });
      const shape = emptyShape(body);
      const accepted = await qboInvoices([nobody], { signal: this.run.signal, realmId: this.run.realmId }).then((r) => r.length === 0, (e: unknown) => { if (stopFor(e)) throw e; return false; });
      this.set("empty_answer", accepted && shape !== "other" ? "as_expected" : "not_as_expected", { shape, accepted });
    });
    // A family's and a sub-customer's balance by id. For a sandbox company the check's own records answer these again below.
    const family = active.find((c) => !ref(c.ParentRef)), sub = active.find((c) => ref(c.ParentRef));
    if (!family) this.set("balance_with_jobs", "not_run", {}, "no_customers");
    else await this.step("balance_with_jobs", [true], async () => {
      const c = await this.read(idOf(family)!);
      const number = typeof c?.BalanceWithJobs === "number";
      this.set("balance_with_jobs", number ? "as_expected" : "not_as_expected", { number });
    });
    if (!sub) this.set("own_balance", "not_run", {}, "no_customers");
    else await this.step("own_balance", [true], async () => {
      const c = await this.read(idOf(sub)!);
      const number = typeof c?.Balance === "number";
      this.set("own_balance", number ? "as_expected" : "not_as_expected", { number });
    });
  }

  /** What every invoice read carries: its fields, the item on each line, and its pay link. `own`: the check's own invoice, for a sandbox. */
  private judgeInvoices(invoices: Raw[], own?: { invoice: Raw | null; itemQboId: string }): void {
    const pool = own?.invoice ? [...invoices, own.invoice] : invoices;
    if (!pool.length) { for (const k of ["invoice_fields", "invoice_items", "pay_links"] as const) this.set(k, "not_run", {}, "no_invoices"); return; }
    const missing = new Set<string>();
    for (const i of pool) {
      if (typeof i.DocNumber !== "string") missing.add("DocNumber");
      if (!isDay(i.TxnDate)) missing.add("TxnDate");
      if (!isDay(i.DueDate)) missing.add("DueDate");
      if (typeof i.TotalAmt !== "number") missing.add("TotalAmt");
      if (typeof i.Balance !== "number") missing.add("Balance");
      if (!isQboId(ref(i.CustomerRef) ?? "")) missing.add("CustomerRef");
    }
    this.set("invoice_fields", missing.size ? "not_as_expected" : "as_expected", { checked: pool.length, missing: [...missing] });

    const itemIds = new Set(this.items.map((i) => idOf(i)).filter((id): id is string => id !== null));
    let lines = 0, withItem = 0, notOnList = 0, withoutItem = 0;
    const visit = (line: unknown, depth: number) => {
      if (!isRow(line) || depth > 2) return;
      const detail = isRow(line.SalesItemLineDetail) ? ref(line.SalesItemLineDetail.ItemRef) : isRow(line.GroupLineDetail) ? ref(line.GroupLineDetail.GroupItemRef) : undefined;
      if (detail === undefined) return; // a subtotal or a discount: no item to carry
      lines++;
      if (detail === null || !isQboId(detail)) withoutItem++; else if (itemIds.has(detail)) withItem++; else notOnList++;
      if (isRow(line.GroupLineDetail) && Array.isArray(line.GroupLineDetail.Line)) for (const inner of line.GroupLineDetail.Line) visit(inner, depth + 1);
    };
    for (const i of pool) if (Array.isArray(i.Line)) for (const l of i.Line) visit(l, 0);
    const ownCarries = own?.invoice ? (Array.isArray(own.invoice.Line) && own.invoice.Line.some((l) => isRow(l) && isRow(l.SalesItemLineDetail) && ref(l.SalesItemLineDetail.ItemRef) === own.itemQboId)) : true;
    this.set("invoice_items", !lines ? "not_run" : withoutItem || notOnList || !ownCarries ? "not_as_expected" : "as_expected", { lines, withItem, notOnList, withoutItem }, lines ? null : "no_invoices");

    const links = pool.map((i) => (typeof i.InvoiceLink === "string" && i.InvoiceLink.trim() ? i.InvoiceLink.trim() : null));
    const present = links.filter((l): l is string => l !== null);
    const unsafe = present.filter((l) => safePayLink(l) === null).length;
    const hosts = [...new Set(present.map(hostOf))].sort().slice(0, 6);
    const ownLinked = own?.invoice ? safePayLink(own.invoice.InvoiceLink) !== null : null;
    const outcome: CheckOutcome = unsafe || ownLinked === false ? "not_as_expected" : ownLinked === true || present.length ? "as_expected" : "learned";
    this.set("pay_links", outcome, { checked: pool.length, withLink: present.length, unsafe, hosts }, ownLinked === false ? "no_link" : null);
  }

  /* ---- Writes: only on records this run makes ---- */

  private async writeSteps(): Promise<void> {
    const run = this.run, base = `Booster Rocket check ${this.tag}`, mark = this.tag.replace(/\W+/g, "-");
    const shape = await getShape();
    const typeIds = this.typesFor(shape);
    if (!typeIds) { for (const x of EXPECTATIONS) if (x.group === "writes" && x.key !== "all_inactive") this.set(x.key, "not_run", {}, "no_types"); return; }
    const m: { famA?: Made | null; famB?: Made | null; student?: Made | null; parent?: Made | null; invoice?: { id: string; marker: string } | null } = {};
    const made = (c: Raw, name: string): Made | null => { const id = idOf(c); return id ? { id, token: tokenOf(c), name } : null; };
    const target = (kind: CheckKind, r: Made) => ({ kind, qboId: r.id });

    await this.step("create_family", [true], async () => {
      const a = await checkCreateCustomer(run, { kind: "family", name: `${base} family A`, typeQboId: typeIds.family, familyQboId: null, email: null });
      m.famA = made(a, `${base} family A`);
      const b = await checkCreateCustomer(run, { kind: "family", name: `${base} family B`, typeQboId: typeIds.family, familyQboId: null, email: null });
      m.famB = made(b, `${base} family B`);
      const typeKept = ref(a.CustomerTypeRef) === typeIds.family && ref(b.CustomerTypeRef) === typeIds.family;
      this.set("create_family", m.famA && m.famB && typeKept ? "as_expected" : "not_as_expected", { typeKept });
    });
    await this.step("duplicate_name", [m.famA], async () => {
      const code = await this.answerTo(() => checkCreateCustomer(run, { kind: "family", name: m.famA!.name, typeQboId: typeIds.family, familyQboId: null, email: null }));
      this.set("duplicate_name", code === `fault_${CUSTOMER_UPDATE.faults.duplicateName}` ? "as_expected" : "not_as_expected", { code });
    });
    await this.step("create_student", [m.famA], async () => {
      const s = await checkCreateCustomer(run, { kind: "student", name: `${base} student`, typeQboId: typeIds.student, familyQboId: m.famA!.id, email: null });
      m.student = made(s, `${base} student`);
      const under = ref(s.ParentRef) === m.famA!.id && s.Job === true, billed = s.BillWithParent === true;
      this.set("create_student", m.student && under && billed ? "as_expected" : "not_as_expected", { under, billed });
    });
    await this.step("contact_phone", [m.famA], async () => {
      const before = await this.read(m.famA!.id);
      await checkUpdateContact(run, target("family", m.famA!), tokenOf(before), { phone: "555-0100" });
      const after = await this.read(m.famA!.id);
      const changed = differences(before, after, ["PrimaryPhone"]), versionRaised = Number(tokenOf(after)) > Number(tokenOf(before));
      this.set("contact_phone", !changed.length && phoneOf(after) === "555-0100" && versionRaised ? "as_expected" : "not_as_expected", { changed, versionRaised });
    });
    const address: CustomerAddress = { line1: "1 Check Street", line2: "Unit 0", city: "Testville", region: "CA", postalCode: "00000", country: "USA" };
    await this.step("contact_address", [m.famA], async () => {
      const before = await this.read(m.famA!.id);
      await checkUpdateContact(run, target("family", m.famA!), tokenOf(before), { address });
      const after = await this.read(m.famA!.id), a = addressOf(after);
      const asSent = a.Line1 === address.line1 && a.Line2 === address.line2 && a.City === address.city && a.CountrySubDivisionCode === address.region && a.PostalCode === address.postalCode && a.Country === address.country;
      const changed = differences(before, after, ["BillAddr"]);
      this.set("contact_address", !changed.length && asSent ? "as_expected" : "not_as_expected", { changed, asSent });
    });
    await this.step("create_parent", [m.famA], async () => {
      const email = `check-parent-${mark}@example.com`;
      const p = await checkCreateCustomer(run, { kind: "parent", name: `${base} parent`, typeQboId: typeIds.parent, familyQboId: m.famA!.id, email });
      m.parent = made(p, `${base} parent`);
      const under = ref(p.ParentRef) === m.famA!.id, emailKept = emailOf(p) === email, copiedContact = Boolean(phoneOf(p) || addressOf(p).Line1);
      this.set("create_parent", m.parent && under && emailKept && p.BillWithParent !== true ? "as_expected" : "not_as_expected", { under, emailKept, copiedContact });
    });
    await this.step("contact_stale", [m.famA], async () => {
      const cur = await this.read(m.famA!.id);
      const code = await this.answerTo(() => checkUpdateContact(run, target("family", m.famA!), older(tokenOf(cur)), { phone: "555-0199" }));
      const after = await this.read(m.famA!.id), unchanged = phoneOf(after) === phoneOf(cur) && tokenOf(after) === tokenOf(cur);
      this.set("contact_stale", code === `fault_${CUSTOMER_UPDATE.faults.stale}` && unchanged ? "as_expected" : "not_as_expected", { code, unchanged });
    });
    const max = (name: string) => CONTACT_FIELDS.find((f) => f.name === name)!.max;
    await this.step("phone_limit", [m.famA], async () => {
      const code = await this.answerTo(async () => checkUpdateContact(run, target("family", m.famA!), tokenOf(await this.read(m.famA!.id)), { phone: "5".repeat(max("phone") + 1) }));
      const thirtyCode = await this.answerTo(async () => checkUpdateContact(run, target("family", m.famA!), tokenOf(await this.read(m.famA!.id)), { phone: "5".repeat(max("phone")) }));
      this.set("phone_limit", isValidation(code) && thirtyCode === "accepted" ? "as_expected" : "not_as_expected", { code, thirty: thirtyCode === "accepted", thirtyCode });
    });
    await this.step("address_limits", [m.famA], async () => {
      const longest: CustomerAddress = { line1: "A".repeat(max("line1")), line2: "B".repeat(max("line2")), city: "C".repeat(max("city")), region: "D".repeat(max("region")), postalCode: "1".repeat(max("postalCode")), country: "E".repeat(max("country")) };
      const send = async (a: CustomerAddress) => this.answerTo(async () => checkUpdateContact(run, target("family", m.famA!), tokenOf(await this.read(m.famA!.id)), { address: a }));
      const code = await send(longest);
      if (code === "accepted") return this.set("address_limits", "as_expected", { refused: [] });
      const parts: [keyof CustomerAddress, string][] = [["line1", "Line1"], ["line2", "Line2"], ["city", "City"], ["region", "CountrySubDivisionCode"], ["postalCode", "PostalCode"], ["country", "Country"]];
      const refused: string[] = [];
      for (const [part, field] of parts) if ((await send({ ...address, [part]: longest[part] })) !== "accepted") refused.push(field);
      this.set("address_limits", "not_as_expected", { refused, code });
    });
    await this.step("clear_fields", [m.famA], async () => {
      const empty: CustomerAddress = { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" };
      const code = await this.answerTo(async () => checkUpdateContact(run, target("family", m.famA!), tokenOf(await this.read(m.famA!.id)), { phone: "", address: empty }));
      if (code !== "accepted") return this.set("clear_fields", "not_as_expected", { code }, code);
      const after = await this.read(m.famA!.id);
      const phoneCleared = phoneOf(after) === "", addressCleared = Object.values(addressOf(after)).every((v) => v === "");
      this.set("clear_fields", phoneCleared && addressCleared ? "as_expected" : "not_as_expected", { phoneCleared, addressCleared });
    });
    await this.step("email_update", [m.famA, m.student, m.parent], async () => {
      const [beforeA, beforeS, beforeP] = [await this.read(m.famA!.id), await this.read(m.student!.id), await this.read(m.parent!.id)];
      const field = `check-family-${mark}@example.com`;
      await checkUpdateEmail(run, target("family", m.famA!), tokenOf(beforeA), field);
      const [afterA, afterS, afterP] = [await this.read(m.famA!.id), await this.read(m.student!.id), await this.read(m.parent!.id)];
      const changed = differences(beforeA, afterA, ["PrimaryEmailAddr"]);
      if (differences(beforeS, afterS, []).length || differences(beforeP, afterP, []).length) changed.push("SubCustomers");
      const versionRaised = Number(tokenOf(afterA)) > Number(tokenOf(beforeA));
      this.set("email_update", !changed.length && emailOf(afterA) === field && versionRaised ? "as_expected" : "not_as_expected", { changed, versionRaised });
    });
    await this.step("email_several", [m.parent], async () => {
      const field = `check-one-${mark}@example.com, check-two-${mark}@example.com`;
      await checkUpdateEmail(run, target("parent", m.parent!), tokenOf(await this.read(m.parent!.id)), field);
      const kept = emailOf(await this.read(m.parent!.id)) === field;
      this.set("email_several", kept ? "as_expected" : "not_as_expected", { kept });
    });
    await this.step("email_length", [m.parent], async () => {
      const field = `${`check-${mark}-`.padEnd(EMAIL_UPDATE.maxLength - "@example.com".length, "x")}@example.com`;
      const code = await this.answerTo(async () => checkUpdateEmail(run, target("parent", m.parent!), tokenOf(await this.read(m.parent!.id)), field));
      this.set("email_length", code === "accepted" ? "as_expected" : "not_as_expected", { code });
    });
    await this.step("email_stale", [m.parent], async () => {
      const cur = await this.read(m.parent!.id);
      const code = await this.answerTo(() => checkUpdateEmail(run, target("parent", m.parent!), older(tokenOf(cur)), `check-stale-${mark}@example.com`));
      const after = await this.read(m.parent!.id), unchanged = emailOf(after) === emailOf(cur) && tokenOf(after) === tokenOf(cur);
      this.set("email_stale", code === `fault_${EMAIL_UPDATE.faults.stale}` && unchanged ? "as_expected" : "not_as_expected", { code, unchanged });
    });
    await this.step("email_invalid", [m.parent], async () => {
      const code = await this.answerTo(async () => checkUpdateEmail(run, target("parent", m.parent!), tokenOf(await this.read(m.parent!.id)), "not an address"));
      this.set("email_invalid", isValidation(code) ? "as_expected" : "not_as_expected", { code });
    });
    await this.step("rename", [m.famA, m.student], async () => {
      const before = await this.read(m.famA!.id), name = `${base} family A renamed`;
      await checkRename(run, target("family", m.famA!), tokenOf(before), name);
      const after = await this.read(m.famA!.id), sub = await this.read(m.student!.id);
      m.famA = { ...m.famA!, name };
      const changed = differences(before, after, ["DisplayName"]);
      const subsFollow = typeof sub?.FullyQualifiedName === "string" && sub.FullyQualifiedName.includes(name);
      this.set("rename", !changed.length && after?.DisplayName === name ? "as_expected" : "not_as_expected", { changed, subsFollow });
    });
    await this.step("rename_stale", [m.famA], async () => {
      const cur = await this.read(m.famA!.id);
      const code = await this.answerTo(() => checkRename(run, target("family", m.famA!), older(tokenOf(cur)), `${base} family A stale`));
      const after = await this.read(m.famA!.id), unchanged = after?.DisplayName === cur?.DisplayName && tokenOf(after) === tokenOf(cur);
      this.set("rename_stale", code === `fault_${CUSTOMER_UPDATE.faults.stale}` && unchanged ? "as_expected" : "not_as_expected", { code, unchanged });
    });

    // The invoice: on the check's m.student, with an active product or service from the company's own list.
    const item = this.items.find((i) => i.Active === true && idOf(i) && (i.Type === "Service" || i.Type === "NonInventory"));
    const itemId = item ? idOf(item)! : null;
    if (!itemId) for (const k of ["invoice_create", "invoice_note", "invoice_no_email", "void_stale", "invoice_void"] as const) this.set(k, "not_run", {}, "no_item");
    const studentInvoice = async (): Promise<Raw | null> => {
      const rows = invoiceRows(await this.get({ query: INVOICE_QUERIES.oneForm(m.student!.id, 1), include: INVOICE_INCLUDE })) ?? [];
      return rows.find((r) => r.Id === m.invoice!.id) ?? null;
    };
    if (itemId) await this.step("invoice_create", [m.student], async () => {
      const marker = randomUUID();
      const inv = await checkCreateInvoice(run, { studentQboId: m.student!.id, itemQboId: itemId, units: 1, unitCents: CHECK_UNIT_CENTS, marker });
      const id = idOf(inv);
      if (id) m.invoice = { id, marker };
      const line = (Array.isArray(inv.Line) ? inv.Line : []).find((l): l is Raw => isRow(l) && isRow(l.SalesItemLineDetail));
      const detail = isRow(line?.SalesItemLineDetail) ? line.SalesItemLineDetail : {};
      const wrong = [
        ...(id && typeof inv.SyncToken === "string" ? [] : ["Id"]), ...(ref(inv.CustomerRef) === m.student!.id ? [] : ["CustomerRef"]),
        ...(toCents(inv.TotalAmt) === CHECK_UNIT_CENTS ? [] : ["TotalAmt"]), ...(toCents(inv.Balance) === CHECK_UNIT_CENTS ? [] : ["Balance"]),
        ...(ref(detail.ItemRef) === itemId ? [] : ["ItemRef"]), ...(detail.Qty === 1 ? [] : ["Qty"]),
      ];
      this.set("invoice_create", wrong.length ? "not_as_expected" : "as_expected", { wrong });
    });
    if (itemId) await this.step("invoice_note", [m.invoice], async () => {
      const mine = await studentInvoice();
      const kept = mine?.PrivateNote === `${INVOICE_WRITES.notePrefix}${m.invoice!.marker}`;
      this.set("invoice_note", kept ? "as_expected" : "not_as_expected", { found: mine !== null, kept });
      // The check's own invoice settles the pay link and the item on its line, beside what the reads found.
      this.judgeInvoices(this.invoices, { invoice: mine, itemQboId: itemId });
      const days = mine && isDay(mine.TxnDate) && isDay(mine.DueDate) ? Math.round((Date.parse(mine.DueDate as string) - Date.parse(mine.TxnDate as string)) / 86_400_000) : null;
      const emailStatus = typeof mine?.EmailStatus === "string" && /^[A-Za-z]{1,20}$/.test(mine.EmailStatus) ? mine.EmailStatus : "";
      this.set("invoice_no_email", emailStatus === "NotSet" ? "as_expected" : "not_as_expected", { emailStatus, ...(days !== null ? { dueDays: days } : {}) });
    });
    if (itemId) await this.step("balance_with_jobs", [m.invoice, m.famA, m.student], async () => {
      const fam = await this.read(m.famA!.id), stu = await this.read(m.student!.id);
      const number = typeof fam?.BalanceWithJobs === "number", includesSubs = toCents(fam?.BalanceWithJobs) === CHECK_UNIT_CENTS;
      this.set("balance_with_jobs", number && includesSubs ? "as_expected" : "not_as_expected", { number, includesSubs });
      const ownNumber = typeof stu?.Balance === "number", matches = toCents(stu?.Balance) === CHECK_UNIT_CENTS && toCents(fam?.Balance ?? 0) === 0;
      this.set("own_balance", ownNumber && matches ? "as_expected" : "not_as_expected", { number: ownNumber, matches });
    });
    await this.step("move", [m.student, m.famB], async () => {
      const before = await this.read(m.student!.id);
      await checkMove(run, m.student!.id, tokenOf(before), m.famB!.id);
      const after = await this.read(m.student!.id);
      const changed = differences(before, after, ["ParentRef"]);
      const mine = m.invoice ? await studentInvoice() : null;
      const invoiceStayed = mine !== null && ref(mine.CustomerRef) === m.student!.id && toCents(mine.Balance) === CHECK_UNIT_CENTS;
      this.set("move", ref(after?.ParentRef) === m.famB!.id && !changed.length ? "as_expected" : "not_as_expected", { changed, ...(m.invoice ? { invoiceStayed } : {}) });
    });
    await this.step("inactive_with_balance", [m.student, m.invoice], async () => {
      const code = await this.answerTo(async () => checkSetActive(run, target("student", m.student!), tokenOf(await this.read(m.student!.id)), false));
      if (code === "accepted") await checkSetActive(run, target("student", m.student!), tokenOf(await this.read(m.student!.id)), true);
      this.set("inactive_with_balance", "learned", { code });
    });
    if (itemId) await this.step("void_stale", [m.invoice], async () => {
      const mine = await studentInvoice();
      const code = await this.answerTo(() => checkVoidInvoice(run, { qboId: m.invoice!.id }, String(Number(tokenOf(mine)) + 1)));
      this.set("void_stale", code === `fault_${INVOICE_WRITES.faults.stale}` ? "as_expected" : "not_as_expected", { code });
    });
    if (itemId) await this.step("invoice_void", [m.invoice], async () => {
      const mine = await studentInvoice();
      if (mine && toCents(mine.TotalAmt) !== 0) await checkVoidInvoice(run, { qboId: m.invoice!.id }, tokenOf(mine));
      const after = await studentInvoice();
      const zero = after !== null && toCents(after.TotalAmt) === 0 && toCents(after.Balance) === 0;
      this.set("invoice_void", zero ? "as_expected" : "not_as_expected", { zero, stillListed: after !== null });
    });
    await this.step("inactive_children", [m.famA, m.parent], async () => {
      await checkSetActive(run, target("family", m.famA!), tokenOf(await this.read(m.famA!.id)), false);
      const fam = await this.read(m.famA!.id), p = await this.read(m.parent!.id);
      const childrenInactive = p?.Active === false;
      if (childrenInactive) await recordClosed(run, "parent", m.parent!.id);
      this.set("inactive_children", fam?.Active === false ? "as_expected" : "not_as_expected", { childrenInactive });
    });
  }

  /** The customer types the check's records are made with: the membership shape's, else the company's first active one. */
  private typesFor(shape: Awaited<ReturnType<typeof getShape>>): { family: string; student: string; parent: string } | null {
    // Only types the company has now: a shape saved for another company names ids that mean nothing here.
    const known = new Set(this.types.filter((t) => t.Active !== false).map((t) => idOf(t)).filter((id): id is string => id !== null));
    const has = (id: string | null | undefined): id is string => typeof id === "string" && known.has(id);
    if (shape?.kind === "layered" && has(shape.familyTypeId)) {
      const or = (id: string | null) => (has(id) ? id : shape.familyTypeId);
      return { family: shape.familyTypeId, student: or(shape.studentTypeId), parent: or(shape.parentTypeId) };
    }
    const first = (shape?.kind === "flat" ? shape.memberTypeIds.find(has) : undefined) ?? [...known][0];
    return first ? { family: first, student: first, parent: first } : null;
  }

  /** Makes every record of this run inactive, and voids its invoice: always, even after a step failed. */
  private async closeAll(): Promise<void> {
    try {
      const closed = await closeRecords(this.run, this.run.id);
      this.set("all_inactive", closed.open ? "not_as_expected" : "as_expected", closed);
    } catch (e) {
      const stop = stopFor(e);
      this.set("all_inactive", "not_as_expected", {}, codeOf(e));
      if (stop) throw new Stopped(stop);
      if (!(e instanceof QboError)) throw e;
    }
  }
}

/**
 * Stops the run when the connected company is no longer the one it started with. For the client's two reads that take
 * no company (the customer types and every customer): what they answered may be another company's, and is not used.
 */
async function stillTheCompany(run: CheckRun): Promise<void> {
  if ((await getConnection())?.realmId !== run.realmId) throw new Stopped("other_company");
}

/** The rows of an invoice query answer; null when it isn't one. Lenient where the portal's own reader is strict: the empty check judges the shape itself. */
function invoiceRows(body: unknown): Raw[] | null {
  if (!isRow(body) || "Fault" in body || "fault" in body || !isRow(body.QueryResponse)) return null;
  const rows = body.QueryResponse.Invoice;
  if (rows === undefined) return [];
  return Array.isArray(rows) ? rows.filter(isRow) : null;
}

/** What an answer that matched nothing looked like. */
function emptyShape(body: unknown): "empty" | "empty_list" | "paging_only" | "other" {
  if (!isRow(body) || !isRow(body.QueryResponse)) return "other";
  const answer = body.QueryResponse, values = Object.entries(answer);
  if (Array.isArray(answer.Invoice) && answer.Invoice.length === 0 && values.every(([k, v]) => k === "Invoice" || typeof v !== "object")) return "empty_list";
  if (answer.Invoice !== undefined) return "other";
  if (!values.length) return "empty";
  return values.every(([, v]) => typeof v !== "object" || v === null) ? "paging_only" : "other";
}

/** Makes inactive, or voids, every record an earlier run left open in this company: first, before anything is made. */
async function cleanUpEarlier(run: CheckRun, customers: Raw[]): Promise<void> {
  const earlier = await db.selectDistinct({ runId: qboCheckRecord.runId }).from(qboCheckRecord)
    .where(and(eq(qboCheckRecord.realmId, run.realmId), ne(qboCheckRecord.runId, run.id), isNull(qboCheckRecord.closedAt)));
  for (const { runId } of earlier) await closeRecords(run, runId, customers);
}

/**
 * Closes the open records of one run (this one, or an earlier one), in the order QuickBooks needs: the invoice voided
 * first, then the student, the parent and the families made inactive. A create whose answer was lost is found again by
 * its exact name in the customer list. Returns how many were closed and how many are still open.
 */
async function closeRecords(run: CheckRun, runId: string, customers?: Raw[]): Promise<{ closed: number; open: number }> {
  const rows = () => db.select().from(qboCheckRecord).where(and(eq(qboCheckRecord.realmId, run.realmId), eq(qboCheckRecord.runId, runId)));
  const ofRun = runId === run.id ? undefined : runId;
  const read = { signal: run.signal, realmId: run.realmId };
  // A create whose answer was lost: its name is the check's own, and QuickBooks keeps names unique.
  const lost = (await rows()).filter((r) => r.qboId === null && r.closedAt === null && r.kind !== "invoice");
  if (lost.length) {
    const list = customers?.length ? customers : await qboQueryAll("Customer", "Active in (true, false)");
    await stillTheCompany(run);
    for (const r of lost) {
      const found = list.filter((c) => c.DisplayName === r.name && idOf(c));
      if (found.length === 1) await recordMade(run, r.id, idOf(found[0]!)!);
    }
  }
  const all = await rows();
  const students = all.filter((r) => r.kind === "student" && r.qboId);
  for (const r of all.filter((x) => x.kind === "invoice" && x.qboId && !x.closedAt)) {
    try {
      let mine: Raw | null = null;
      for (const s of students) {
        const rows = invoiceRows(await qboGet("query", { query: INVOICE_QUERIES.oneForm(s.qboId!, 1), include: INVOICE_INCLUDE }, read)) ?? [];
        mine = rows.find((i) => i.Id === r.qboId) ?? mine;
      }
      if (mine && toCents(mine.TotalAmt) === 0) await recordClosed(run, "invoice", r.qboId!);
      else if (mine) await checkVoidInvoice(run, { qboId: r.qboId!, ofRun }, tokenOf(mine));
      else await noteCloseFailed(run, "invoice", r.qboId!, "not_found");
    } catch (e) { if (stopFor(e) || !(e instanceof QboError)) throw e; await noteCloseFailed(run, "invoice", r.qboId!, codeOf(e)); }
  }
  const order: Record<string, number> = { student: 0, parent: 1, family: 2 };
  for (const r of all.filter((x) => x.kind !== "invoice" && x.qboId && !x.closedAt).sort((a, b) => order[a.kind]! - order[b.kind]!)) {
    try {
      const c = await qboCustomerById(r.qboId!, read);
      if (!c) await noteCloseFailed(run, r.kind, r.qboId!, "not_found");
      else if (c.Active === false) await recordClosed(run, r.kind, r.qboId!);
      else await checkSetActive(run, { kind: r.kind, qboId: r.qboId!, ofRun }, tokenOf(c), false);
    } catch (e) { if (stopFor(e) || !(e instanceof QboError)) throw e; await noteCloseFailed(run, r.kind, r.qboId!, codeOf(e)); }
  }
  const end = await rows();
  return { closed: end.filter((r) => r.closedAt && r.qboId).length, open: end.filter((r) => !r.closedAt).length };
}
