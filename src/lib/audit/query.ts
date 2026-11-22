import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, max, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, accountingLinkEnded, auditLog, requirement } from "@/lib/db/schema";
import { QUICKBOOKS } from "@/lib/families/ids";
import { getRosterSource } from "@/lib/roster/source";
import { isUuid } from "@/lib/seasons/ids";

/**
 * Reading the audit log for the staff page and its export (Audit.Log.Read, Admin only: the rows hold notes staff write
 * about parents). Everything here takes values that came from an address bar, so each is checked for type and size
 * before it reaches a query, and each reaches the query as a parameter, never as text.
 *
 * Rows are in the order they were written (`id`), newest first, and a page is asked for by the id it starts after, so
 * a page stays the same page while new rows arrive. The queries are correct with only the primary key; indexes on
 * the action, on the actor's id and on the record (type, id) keep the filters quick once the log is large.
 */
export type AuditRow = typeof auditLog.$inferSelect;
export type AuditFilters = {
  action: string | null;
  /** Part of a name or email as it was written on the row, or a whole staff or parent id. */
  who: string | null;
  /** Rows at or after this instant. */
  from: Date | null;
  /** Rows before this instant. */
  to: Date | null;
  /** The record acted on: a type and an id ("parent:1b2c…"), or one word that is either. */
  record: { type: string; id: string } | { either: string } | null;
};
export const NO_FILTERS: AuditFilters = { action: null, who: null, from: null, to: null, record: null };
export const AUDIT_PAGE_SIZE = 50;
const MAX_TEXT = 200;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

type Params = { get(name: string): string | null } | Record<string, string | string[] | undefined>;
const reader = (p: Params) => (name: string): string => {
  const v = typeof (p as { get?: unknown }).get === "function" ? (p as URLSearchParams).get(name) : (p as Record<string, string | string[] | undefined>)[name];
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === "string" ? one.trim().slice(0, MAX_TEXT) : "";
};

/** An instant ("2026-11-15T06:00:00.000Z"), or a day ("2026-11-15"), which is that day in UTC. Anything else is no filter. */
function instant(text: string, endOfDay: boolean): Date | null {
  if (!text) return null;
  if (DAY.test(text)) {
    const t = Date.parse(`${text}T00:00:00.000Z`);
    return Number.isNaN(t) ? null : new Date(t + (endOfDay ? DAY_MS : 0));
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t);
}

/** The filters in an address. Unknown or malformed values are dropped, never guessed at. */
export function parseAuditFilters(params: Params): AuditFilters {
  const get = reader(params);
  const record = get("record").replace(/^:+|:+$/g, "").trim();
  const cut = record.indexOf(":");
  return {
    action: get("action") || null,
    who: get("who") || null,
    from: instant(get("from"), false),
    to: instant(get("to"), true),
    record: !record ? null : cut > 0 && cut < record.length - 1 ? { type: record.slice(0, cut).trim(), id: record.slice(cut + 1).trim() } : { either: record },
  };
}

/** A whole number id from an address ("before", "after"), or null. */
export function parseCursor(params: Params, name: "before" | "after"): number | null {
  const v = reader(params)(name);
  return /^[1-9]\d{0,15}$/.test(v) ? Number(v) : null;
}

export const recordText = (r: AuditFilters["record"]): string => (!r ? "" : "either" in r ? r.either : `${r.type}:${r.id}`);

/** The filters as an address's query, for the page links and the export link. Instants are written whole. */
export function filtersQuery(f: AuditFilters, extra: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams();
  if (f.action) q.set("action", f.action);
  if (f.who) q.set("who", f.who);
  if (f.from) q.set("from", f.from.toISOString());
  if (f.to) q.set("to", f.to.toISOString());
  if (f.record) q.set("record", recordText(f.record));
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const hasFilters = (f: AuditFilters): boolean => Boolean(f.action || f.who || f.from || f.to || f.record);

const likeText = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;
const endsWithKey = (s: string) => `%:${s.replace(/[\\%_]/g, "\\$&")}`;

/**
 * The target types an audit row may name a QuickBooks customer under, by the kind of record the customer was. A family:
 * "qbo_customer" (the roster's own rows), and "family", which holds two kinds of id: a customer's in the rows the
 * season's and volunteering's family pages wrote before those areas moved, and in the money.balance_mismatch rows written
 * before the money cache moved (src/lib/money/family-money.ts); and the app family's own id in the rows written since
 * the areas moved (money.balance_mismatch and the Balances family page's money.family.read among them), which the
 * filter's exact match finds. A student: "qbo_customer", and
 * "student" (a moved student's volunteer places, by customer before volunteering moved, by the record since). A row of
 * any other type whose id happens to be the same number (a job run, a product, a check's run) is never a customer's.
 */
export const CUSTOMER_TARGET_TYPES = { family: ["qbo_customer", "family"], student: ["qbo_customer", "student"] } as const;

/**
 * The QuickBooks customers an app family or student record (a uuid) is or was linked to, in every company the roster
 * was read from, by the kind of record they are linked to, when the filter names one: "family:<id>", "student:<id>",
 * or the id alone. Open question 17 of the app-owned families spec: audit rows are never rewritten, and rows written
 * before an area moved to the app's ids name the customer, so a search for the record also finds those. A customer's
 * number means a customer only in its own company, so each link's window is cut to its company's time as the roster's
 * (stage 4's slice M8a, companyPeriods()): after a change of company the earlier company's numbers still find the rows
 * written in its time, and never those of the company after it, where the same number is another customer.
 */
async function customersOfRecord(record: AuditFilters["record"]): Promise<RecordNames | null> {
  if (!record) return null;
  const [type, id] = "either" in record ? [null, record.either] : [record.type, record.id];
  if (!isUuid(id) || (type !== null && type !== "family" && type !== "student")) return null;
  const realmId = await getRosterSource();
  if (realmId === null) return { id, kind: type, families: [], students: [] };
  const ofRecord = (t: typeof accountingLink | typeof accountingLinkEnded) => (type === "family" ? sql`${t.familyId}::text = ${id}` : type === "student" ? sql`${t.studentId}::text = ${id}`
    : sql`(${t.familyId}::text = ${id} or ${t.studentId}::text = ${id})`);
  // The record's links that are, and its links that were (stage 4's slice M3b: an unlink moves them to
  // accounting_link_ended; slice M7a: so does a change of company, as `company_changed`), in every company; and the
  // companies' times as the roster's. Every instant is read as text to the microsecond (usText()), never as a Date.
  const [live, ended, periods] = await Promise.all([
    db.select({ realmId: accountingLink.realmId, customerId: accountingLink.customerId, familyId: accountingLink.familyId }).from(accountingLink)
      .where(and(eq(accountingLink.system, QUICKBOOKS), ofRecord(accountingLink))),
    db.select({ realmId: accountingLinkEnded.realmId, customerId: accountingLinkEnded.customerId, familyId: accountingLinkEnded.familyId, endedAt: usText(accountingLinkEnded.endedAt) })
      .from(accountingLinkEnded).where(and(eq(accountingLinkEnded.system, QUICKBOOKS), ofRecord(accountingLinkEnded))),
    companyPeriods(realmId),
  ]);
  const mine = [...live.map((l) => ({ ...l, endedAt: null as Instant | null })), ...ended];
  if (mine.length === 0) return { id, kind: type, families: [], students: [] };
  // Each customer's other records of the same kind (a family's or a student's, never a guardian row's) whose links to
  // it ended, in the same company: the latest that ended before this record's link bounds its window from below (rows
  // about the customer written then were that other record's). Two records of one kind are never linked to one customer
  // of a company at once (the unique indexes accounting_link_family_customer_uq and _student_customer_uq, on the realm
  // and the customer), so every other record's link to it ended before this record's live link was made, and before
  // this record's ended link ended exactly when it ended first: the bound compares ended_at with ended_at, never with
  // linked_at, which a link takes from its transaction's start, before it waited for the roster lock. The same number
  // in another company is another customer: its links never bound this one's (matched below by realm and customer).
  const others = ended.length === 0 && (await db.select({ id: accountingLinkEnded.id }).from(accountingLinkEnded).limit(1)).length === 0 ? []
    : await db.select({ realmId: accountingLinkEnded.realmId, customerId: accountingLinkEnded.customerId, familyId: accountingLinkEnded.familyId,
      studentId: accountingLinkEnded.studentId, endedAt: usText(accountingLinkEnded.endedAt) })
      .from(accountingLinkEnded)
      .where(and(eq(accountingLinkEnded.system, QUICKBOOKS), inArray(accountingLinkEnded.realmId, [...new Set(mine.map((l) => l.realmId))]),
        inArray(accountingLinkEnded.customerId, [...new Set(mine.map((l) => l.customerId))]), sql`coalesce(${ofRecord(accountingLinkEnded)}, false) = false`));
  const windowsOf = (asFamily: boolean): Window[] => mine.filter((l) => (l.familyId !== null) === asFamily).flatMap((l) => {
    const period = periodOfLink(periods, realmId, l);
    if (!period) return [];
    const before = others.filter((o) => o.realmId === l.realmId && o.customerId === l.customerId && (asFamily ? o.familyId !== null : o.studentId !== null)
      && (l.endedAt === null || o.endedAt < l.endedAt)).reduce<Instant | null>((a, o) => later(a, o.endedAt), null);
    const from = later(before, period.from), to = earlier(l.endedAt, period.to);
    // A window cut to nothing (a link that ended before its company's time began) finds nothing.
    return from !== null && to !== null && from >= to ? [] : [{ customerId: l.customerId, from, to }];
  });
  return { id, kind: type, families: windowsOf(true), students: windowsOf(false) };
}

/**
 * An instant as the database holds it, to the microsecond, in UTC: "2026-11-20T12:00:00.123456Z". A JavaScript Date
 * keeps only the millisecond, and a bound cut to it puts the rest of that millisecond on the wrong side of it (a change
 * of company's own rows, and a row written just before it, in the next company's time). Every one has the same width,
 * so two compare as text as they do as instants; one goes back into a query as `<text>::timestamptz` (named()).
 */
type Instant = string;
const usText = (col: SQL | AnyColumn) => sql<Instant>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The later of two lower bounds, and the earlier of two upper bounds, null being no bound. */
const later = (a: Instant | null, b: Instant | null) => (a === null ? b : b === null || a > b ? a : b);
const earlier = (a: Instant | null, b: Instant | null) => (a === null ? b : b === null || a < b ? a : b);

/**
 * One company's time as the roster's: after `from` and at or before `to`, null bounding nothing (stage 4's slice M8a).
 * `until` is where the time after it ended (the next change of company's boundary), null for none: a link of this
 * company that ended after that lived in a later time of the company, or one the records lost, never this one.
 */
type Period = { realmId: string; from: Instant | null; to: Instant | null; until: Instant | null };

/**
 * Each company's times as the roster's, oldest first, from the change of company's own records: every clear writes one
 * `roster.cleared` row (src/lib/roster/source.ts), `before.realmId` the company it ended and `after.realmId` the one it
 * started, `after.reason` `different_company`, in its transaction, and the audit log is append-only. Each row, in id
 * order, ends the period of its `before.realmId` and starts one of its `after.realmId` at its boundary: the later of
 * the row's `at` (the clear's transaction start, the instant its own audit rows carry, so they fall in the earlier
 * company's period) and the `ended_at` of the links it ended `company_changed` (one statement after its locks, nearer
 * its commit: in the roster refresh's backstop the clear's transaction is the refresh's, begun before it read
 * QuickBooks). A clear's links are those of its `before.realmId` ended `company_changed` at or after its `at`, the
 * latest such clear's. The first company's first period is open below; the roster's company's current one is open
 * above. A to B to A gives A two periods and B one. With no such row, the roster's company has one period, open at both
 * ends, and nothing more is read: the filter is as before.
 *
 * Where the records can't place a company, it gets no period, so the filter finds less, never more: a row without
 * `before.realmId` (as text) ends no period, so the company before it has none for that time; a row without
 * `after.realmId` ends the period before it and starts none; a row whose `before.realmId` isn't the company the row
 * before it started ends no period (neither company's time is known); and when the last row's `after.realmId` isn't
 * the roster's company, the roster's company has no current period.
 */
async function companyPeriods(roster: string): Promise<Period[]> {
  // The key is written here, never a value from the address.
  const realm = (side: "before" | "after") => {
    const v = side === "before" ? auditLog.before : auditLog.after;
    return sql<string | null>`case when jsonb_typeof(${v} -> 'realmId') = 'string' and ${v} ->> 'realmId' <> '' then ${v} ->> 'realmId' end`;
  };
  // An indexed read (audit_action_ix: action, id), the rows of every clear; none in a database that never changed company.
  const clears = await db.select({ at: usText(auditLog.at), from: realm("before"), to: realm("after") }).from(auditLog)
    .where(and(eq(auditLog.action, "roster.cleared"), sql`${auditLog.after} ->> 'reason' = 'different_company'`)).orderBy(asc(auditLog.id));
  if (clears.length === 0) return [{ realmId: roster, from: null, to: null, until: null }];
  // Only once the company has changed: the instants the clears ended links at, one for each clear that ended any.
  const ends = await db.selectDistinct({ realmId: accountingLinkEnded.realmId, endedAt: usText(accountingLinkEnded.endedAt) }).from(accountingLinkEnded)
    .where(and(eq(accountingLinkEnded.system, QUICKBOOKS), eq(accountingLinkEnded.endedHow, "company_changed")));
  const boundaries = clears.map((c) => c.at);
  for (const e of ends) {
    const i = clears.findLastIndex((c) => c.from === e.realmId && c.at <= e.endedAt);
    if (i >= 0) boundaries[i] = later(boundaries[i]!, e.endedAt)!;
  }
  const periods: Period[] = [];
  let open: { realmId: string | null; from: Instant | null } = { realmId: clears[0]!.from, from: null };
  clears.forEach((c, i) => {
    if (open.realmId !== null && open.realmId === c.from) periods.push({ realmId: open.realmId, from: open.from, to: boundaries[i]!, until: boundaries[i + 1] ?? null });
    open = { realmId: c.to, from: boundaries[i]! };
  });
  if (open.realmId === roster) periods.push({ realmId: roster, from: open.from, to: null, until: null });
  return periods;
}

/**
 * The period a link of the record lived in: a live link's is the roster's company's current one (a live link of any
 * other company finds nothing); an ended link's is the latest of its company's periods that began before it ended and
 * whose next company's time hadn't ended by then (`until`). An unlink ends a link inside its period; a change of
 * company ends one at its period's end. A link of a company no period holds then finds nothing.
 */
function periodOfLink(periods: readonly Period[], roster: string, l: { realmId: string; endedAt: Instant | null }): Period | undefined {
  if (l.endedAt === null) return l.realmId === roster ? periods.find((p) => p.realmId === roster && p.to === null) : undefined;
  const endedAt = l.endedAt;
  return periods.filter((p) => p.realmId === l.realmId && (p.from === null || p.from < endedAt) && (p.until === null || endedAt <= p.until)).at(-1);
}
/**
 * One customer a record is or was linked to, and when it was the record's (stage 4's slice M3b): rows naming the customer
 * match only when written after `from` (the latest unlink of another record of the same kind from that customer in its
 * company, before this record's link to it ended, or before now for its live link) and at or before `to` (this record's
 * own unlink of it); null bounds nothing. Since stage 4's slice M8a each is cut to its company's time as the roster's,
 * the later `from` and the earlier `to`, every bound an Instant, to the microsecond. It carries no company: an audit
 * row names a number only, so the company is applied when the window is made, and every reader through named() is
 * right without a change of its own. With no ended link anywhere and no change of company every window is unbounded,
 * and the filter finds what it found before.
 */
type Window = { customerId: string; from: Instant | null; to: Instant | null };
/** A family or student record the filter names (`kind` null when the filter gave the id alone), and the customers it is or was linked to, each with its window. */
type RecordNames = { id: string; kind: "family" | "student" | null; families: Window[]; students: Window[] };

/**
 * The conditions that match an expression naming one of these customers, each inside its window: the unbounded ones in
 * one list, as before slice M3b, and each bounded one apart, its bounds compared to the microsecond. None for no customer.
 */
function named(expr: SQL, ws: readonly Window[], match: (expr: SQL, customers: string[]) => SQL = (e, c) => inArray(e, c)): SQL[] {
  if (ws.length === 0) return [];
  const open = [...new Set(ws.filter((w) => w.from === null && w.to === null).map((w) => w.customerId))];
  const bounded = ws.filter((w) => (w.from !== null || w.to !== null) && !open.includes(w.customerId));
  return [...(open.length ? [match(expr, open)] : []),
    ...bounded.map((w) => and(match(expr, [w.customerId]), w.from === null ? undefined : sql`${auditLog.at} > ${w.from}::timestamptz`,
      w.to === null ? undefined : sql`${auditLog.at} <= ${w.to}::timestamptz`)!)];
}

/**
 * A form request's rows (target "signature_request") name its family and student in their body, not their target: the
 * customers' ids before forms moved to the app's ids (`familyQboId`, `subjectQboId`), the records' since (`familyId`,
 * `studentId`), in `after` and, for a move, `before`. A kept form's rows (target "signed_form_evidence") are never
 * matched this way: an earlier company's evidence holds that company's numbers, which may be a current family's.
 */
function formRowsOf(r: RecordNames): SQL {
  // The key is one of the four written here, never a value from the address: written into the query as a text literal.
  const said = (side: "before" | "after", key: "familyId" | "studentId" | "familyQboId" | "subjectQboId") =>
    sql`(${side === "before" ? auditLog.before : auditLog.after}) ->> ${sql.raw(`'${key}'`)}`;
  const family = r.kind === "student" ? [] : [eq(said("after", "familyId"), r.id), eq(said("before", "familyId"), r.id),
    ...named(said("after", "familyQboId"), r.families), ...named(said("before", "familyQboId"), r.families)];
  const student = r.kind === "family" ? [] : [eq(said("after", "studentId"), r.id), eq(said("before", "studentId"), r.id),
    ...named(said("after", "subjectQboId"), r.students)];
  return and(eq(auditLog.targetType, "signature_request"), or(...family, ...student))!;
}

/**
 * A buy-out's rows (target "buyout") name its family and student in their body, not their target. Before buy-outs moved
 * to the app's ids: the choice named its subject's customer (`subjectQboId`: the family's for a per-family buy-out, the
 * student's for a per-student one), the daily check's flag and the close the family's (`familyQboId`), and a move's flag
 * the families it went from and to (`fromFamilyQboId`, `toFamilyQboId`). Since: the records (`familyId`, `studentId`,
 * and a move's `toFamilyId`), in `after` or, for the close, `before`. An old choice's `subjectQboId` is a family's only
 * when its requirement (`requirementId`, kept while the buy-out is) asks of each family, and a student's only when it
 * asks of each student: a customer may have a record of each kind, and a per-student choice naming it as a student is
 * never its family's (nor a per-family one its student's).
 */
function buyoutRowsOf(r: RecordNames): SQL {
  // The key is one of those written here, never a value from the address: written into the query as a text literal.
  type Key = "familyId" | "studentId" | "toFamilyId" | "familyQboId" | "subjectQboId" | "fromFamilyQboId" | "toFamilyQboId" | "requirementId";
  const said = (side: "before" | "after", key: Key) => sql`(${side === "before" ? auditLog.before : auditLog.after}) ->> ${sql.raw(`'${key}'`)}`;
  // An old choice's subject, of the kind its requirement asks of ("family" or "student", written here, never from the address).
  const subjectAs = (kind: "family" | "student", customers: string[]) => and(inArray(said("after", "subjectQboId"), customers),
    sql`exists (select 1 from ${requirement} where ${requirement.id}::text = ${said("after", "requirementId")} and ${requirement.appliesTo} = ${kind})`)!;
  const family = r.kind === "student" ? [] : [eq(said("after", "familyId"), r.id), eq(said("before", "familyId"), r.id), eq(said("after", "toFamilyId"), r.id),
    ...(["familyQboId", "fromFamilyQboId", "toFamilyQboId"] as const).flatMap((k) => named(said("after", k), r.families)),
    ...named(said("before", "familyQboId"), r.families), ...named(said("after", "subjectQboId"), r.families, (_e, c) => subjectAs("family", c))];
  const student = r.kind === "family" ? [] : [eq(said("after", "studentId"), r.id), eq(said("before", "studentId"), r.id),
    ...named(said("after", "subjectQboId"), r.students, (_e, c) => subjectAs("student", c))];
  return and(eq(auditLog.targetType, "buyout"), or(...family, ...student))!;
}

/**
 * A parent's sign-in rows (target "parent": `signin`, `signin.refused`, `signin.family_switch`) name the family entered
 * in their body, not their target: its customer before the session moved to the app's family (stage 3's fifth slice:
 * `familyQboId`, and a switch's `from` and `to`), its record since (`familyId`, and a switch's `from` and `to`). A change
 * of sign-in address (`parent.email.request`, `parent.email.save`, whose target was the QuickBooks record it changed,
 * and is the person since stage 3's slice 11d)
 * names the family it was asked in only since then (`familyId`): an older one is found by its record, when that is the
 * family's own customer (CUSTOMER_TARGET_TYPES). A membership given or ended (`parent.access.granted`,
 * `parent.access.ended`, whose target is the guardian row) and a person made by staff for a family (`parent.create`,
 * whose target is the person) name the family in their body: its record (`familyId`, stage 3's slice 7b), and in rows
 * the retired reconcile wrote its customer (`familyQboId`). Nothing of a student's.
 */
function parentRowsOf(r: RecordNames): SQL | undefined {
  if (r.kind === "student") return undefined;
  // The key is one of the four written here, never a value from the address: written into the query as a text literal.
  const said = (key: "familyId" | "familyQboId" | "from" | "to") => sql`(${auditLog.after}) ->> ${sql.raw(`'${key}'`)}`;
  return or(
    and(eq(auditLog.targetType, "parent"), inArray(auditLog.action, ["signin", "signin.refused"]),
      or(eq(said("familyId"), r.id), ...named(said("familyQboId"), r.families))),
    and(eq(auditLog.targetType, "parent"), eq(auditLog.action, "signin.family_switch"),
      or(eq(said("from"), r.id), eq(said("to"), r.id), ...named(said("from"), r.families), ...named(said("to"), r.families))),
    and(inArray(auditLog.action, ["parent.email.request", "parent.email.save"]), eq(said("familyId"), r.id)),
    and(eq(auditLog.targetType, "guardian"), inArray(auditLog.action, ["parent.access.granted", "parent.access.ended"]),
      or(eq(said("familyId"), r.id), ...named(said("familyQboId"), r.families))),
    and(eq(auditLog.targetType, "parent"), eq(auditLog.action, "parent.create"), eq(said("familyId"), r.id)),
  );
}

/**
 * A student's move names both its families in its body, not its target (the student, or before slice 9f the student's
 * customer): the portal's save (`roster.record.moved`: the family left as `before.familyId` and `after.fromFamilyId`,
 * the family joined as `after.familyId`; since stage 4's slice M4a, a move taken from the books on the accounting links
 * screen likewise, `accounting.difference.take` with `after.field` `place`) and its follow-ups (`roster.student.move.followed`: `fromFamilyId` and
 * `toFamilyId` since, the customers `fromFamilyQboId` and `toFamilyQboId` before), and its send to QuickBooks
 * (`roster.student.move`, whose target is the student's customer: where the cache had them before, `before.familyQboId`,
 * and where QuickBooks' answer has them, `after.familyQboId`). A search for either family finds them; a search for the
 * student finds them by their target. Nothing of a student's here.
 */
function moveRowsOf(r: RecordNames): SQL | undefined {
  if (r.kind === "student") return undefined;
  // The key is one of those written here, never a value from the address: written into the query as a text literal.
  type Key = "familyId" | "fromFamilyId" | "toFamilyId" | "fromFamilyQboId" | "toFamilyQboId" | "familyQboId" | "field";
  const said = (side: "before" | "after", key: Key) => sql`(${side === "before" ? auditLog.before : auditLog.after}) ->> ${sql.raw(`'${key}'`)}`;
  return or(
    and(eq(auditLog.action, "roster.record.moved"), or(eq(said("before", "familyId"), r.id), eq(said("after", "familyId"), r.id), eq(said("after", "fromFamilyId"), r.id))),
    // A move taken from the books on the accounting links screen (stage 4's slice M4a) names both families as a portal move's row does.
    and(eq(auditLog.action, "accounting.difference.take"), eq(said("after", "field"), "place"),
      or(eq(said("before", "familyId"), r.id), eq(said("after", "familyId"), r.id), eq(said("after", "fromFamilyId"), r.id))),
    // A student's family sent to the books from the accounting links screen (slice M5a): the family they are in, and the family record the books had them under, when one is.
    and(eq(auditLog.action, "accounting.difference.send"), eq(said("after", "field"), "place"), or(eq(said("after", "familyId"), r.id), eq(said("after", "fromFamilyId"), r.id))),
    and(eq(auditLog.action, "roster.student.move.followed"), or(eq(said("after", "fromFamilyId"), r.id), eq(said("after", "toFamilyId"), r.id),
      ...named(said("after", "fromFamilyQboId"), r.families), ...named(said("after", "toFamilyQboId"), r.families))),
    ...(r.families.length ? [and(eq(auditLog.action, "roster.student.move"), or(...named(said("before", "familyQboId"), r.families), ...named(said("after", "familyQboId"), r.families)))] : []),
  );
}

/**
 * A confirm on the accounting links screen (`accounting.link.confirm`, stage 4's slice M3a) targets the family and names
 * the students it linked only in its body (`after.studentsLinked`, each `{ studentId, customerQboId }`): a search for
 * one of those students finds it there, as a move's rows are found by the families they name, and so does an unlink
 * (`accounting.link.remove`, slice M3b) for each student whose link it ended (`after.studentLinksEnded`). The family
 * finds both by their target.
 */
function confirmRowsOf(r: RecordNames): SQL | undefined {
  if (r.kind === "family") return undefined;
  return or(and(eq(auditLog.action, "accounting.link.confirm"), sql`(${auditLog.after}) -> 'studentsLinked' @> ${JSON.stringify([{ studentId: r.id }])}::jsonb`),
    // An unlink (slice M3b) targets the family and names the students whose links it ended in its body.
    and(eq(auditLog.action, "accounting.link.remove"), sql`(${auditLog.after}) -> 'studentLinksEnded' @> ${JSON.stringify([{ studentId: r.id }])}::jsonb`));
}

/**
 * The rows a family or student record's older names find:a row naming one of its customers under a target type that
 * names a customer of that kind (CUSTOMER_TARGET_TYPES), and a tick's or waiver's row, whose target is
 * "<requirement>:<subject>", naming the customer (before the seasons moved) or the record (since).
 */
function recordsOlderNames(r: RecordNames): SQL | undefined {
  // A tick's or waiver's target ends with its subject: the record's own id, or one of its customers inside its window.
  const endsWith = (e: SQL, keys: string[]) => or(...keys.map((k) => sql`${e} like ${endsWithKey(k)} escape '\\'`))!;
  return or(
    formRowsOf(r),
    buyoutRowsOf(r),
    parentRowsOf(r),
    moveRowsOf(r),
    confirmRowsOf(r),
    ...named(sql`${auditLog.targetId}`, r.families, (e, c) => and(inArray(auditLog.targetType, [...CUSTOMER_TARGET_TYPES.family]), inArray(e, c))!),
    ...named(sql`${auditLog.targetId}`, r.students, (e, c) => and(inArray(auditLog.targetType, [...CUSTOMER_TARGET_TYPES.student]), inArray(e, c))!),
    and(eq(auditLog.targetType, "requirement_progress"), or(endsWith(sql`${auditLog.targetId}`, [r.id]), ...named(sql`${auditLog.targetId}`, r.families, endsWith), ...named(sql`${auditLog.targetId}`, r.students, endsWith))),
  );
}

async function where(f: AuditFilters): Promise<SQL | undefined> {
  const parts: (SQL | undefined)[] = [];
  if (f.action) parts.push(eq(auditLog.action, f.action));
  if (f.who) parts.push(or(sql`${auditLog.actorLabel} ilike ${likeText(f.who)} escape '\\'`, eq(auditLog.actorId, f.who)));
  if (f.from) parts.push(gte(auditLog.at, f.from));
  if (f.to) parts.push(lt(auditLog.at, f.to));
  if (f.record) {
    const exact = "either" in f.record ? or(eq(auditLog.targetId, f.record.either), eq(auditLog.targetType, f.record.either))
      : and(eq(auditLog.targetType, f.record.type), eq(auditLog.targetId, f.record.id));
    const record = await customersOfRecord(f.record);
    parts.push(record ? or(exact, recordsOlderNames(record)) : exact);
  }
  return parts.length ? and(...parts) : undefined;
}

export type AuditPage = {
  rows: AuditRow[];
  total: number;
  /** The id to ask for the page of newer rows with (`after`), or null on the newest page. */
  newer: number | null;
  /** The id to ask for the page of older rows with (`before`), or null on the oldest page. */
  older: number | null;
};

/** One page, newest first. `before` gives the rows older than that id; `after` the rows newer than it; neither, the newest. */
export async function auditPage(f: AuditFilters, cursor: { before?: number | null; after?: number | null } = {}, size = AUDIT_PAGE_SIZE): Promise<AuditPage> {
  const filter = await where(f);
  let rows: AuditRow[];
  if (cursor.after) {
    rows = (await db.select().from(auditLog).where(and(filter, gt(auditLog.id, cursor.after))).orderBy(asc(auditLog.id)).limit(size)).reverse();
  } else {
    rows = await db.select().from(auditLog).where(and(filter, cursor.before ? lt(auditLog.id, cursor.before) : undefined)).orderBy(desc(auditLog.id)).limit(size);
  }
  const [{ n }] = (await db.select({ n: count() }).from(auditLog).where(filter)) as [{ n: number }];
  if (rows.length === 0) return { rows, total: n, newer: null, older: null };
  const first = rows[0]!.id, last = rows.at(-1)!.id;
  const [[anyNewer], [anyOlder]] = await Promise.all([
    db.select({ id: auditLog.id }).from(auditLog).where(and(filter, gt(auditLog.id, first))).limit(1),
    db.select({ id: auditLog.id }).from(auditLog).where(and(filter, lt(auditLog.id, last))).limit(1),
  ]);
  return { rows, total: n, newer: anyNewer ? first : null, older: anyOlder ? last : null };
}

/** When the newest row was written, or null for an empty log: the Settings rail's one line for the audit log. */
export async function newestAuditAt(): Promise<Date | null> {
  const [row] = await db.select({ at: auditLog.at }).from(auditLog).orderBy(desc(auditLog.id)).limit(1);
  return row?.at ?? null;
}

/** The actions the log holds, for the filter's list. */
export async function auditActions(): Promise<string[]> {
  return (await db.selectDistinct({ action: auditLog.action }).from(auditLog).orderBy(asc(auditLog.action)).limit(500)).map((r) => r.action);
}

/**
 * What an export will hold: how many rows match now, and the newest id among them. The export then reads only rows up
 * to that id, so the count that is audited is the count that is sent, whatever is written while it streams (its own
 * audit row included).
 */
export async function auditExportScope(f: AuditFilters): Promise<{ rows: number; upTo: number }> {
  const [r] = await db.select({ n: count(), top: max(auditLog.id) }).from(auditLog).where(await where(f));
  return { rows: r?.n ?? 0, upTo: r?.top ?? 0 };
}

/** Every matching row up to `upTo`, newest first, a batch at a time. */
export async function* auditExportRows(f: AuditFilters, upTo: number, batch = 1000): AsyncGenerator<AuditRow[]> {
  let before = upTo + 1;
  const filter = await where(f);
  for (;;) {
    const rows = await db.select().from(auditLog).where(and(filter, lt(auditLog.id, before), lte(auditLog.id, upTo))).orderBy(desc(auditLog.id)).limit(batch);
    if (rows.length === 0) return;
    yield rows;
    before = rows.at(-1)!.id;
    if (rows.length < batch) return;
  }
}
