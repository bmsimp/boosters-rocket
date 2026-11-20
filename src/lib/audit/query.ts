import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, max, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, requirement } from "@/lib/db/schema";
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
 * The QuickBooks customers an app family or student record (a uuid) is linked to, in the company the roster was read
 * from, by the kind of record they are linked to, when the filter names one: "family:<id>", "student:<id>", or the id
 * alone. Open question 17 of the app-owned families spec: audit rows are never rewritten, and rows written before an
 * area moved to the app's ids name the customer, so a search for the record also finds those.
 */
async function customersOfRecord(record: AuditFilters["record"]): Promise<RecordNames | null> {
  if (!record) return null;
  const [type, id] = "either" in record ? [null, record.either] : [record.type, record.id];
  if (!isUuid(id) || (type !== null && type !== "family" && type !== "student")) return null;
  const realmId = await getRosterSource();
  if (realmId === null) return { id, kind: type, families: [], students: [] };
  const kind = type === "family" ? sql`${accountingLink.familyId}::text = ${id}` : type === "student" ? sql`${accountingLink.studentId}::text = ${id}`
    : sql`(${accountingLink.familyId}::text = ${id} or ${accountingLink.studentId}::text = ${id})`;
  const links = await db.select({ customerId: accountingLink.customerId, familyId: accountingLink.familyId }).from(accountingLink)
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), kind));
  return { id, kind: type, families: [...new Set(links.filter((l) => l.familyId !== null).map((l) => l.customerId))], students: [...new Set(links.filter((l) => l.familyId === null).map((l) => l.customerId))] };
}
/** A family or student record the filter names (`kind` null when the filter gave the id alone), and the customers it is linked to. */
type RecordNames = { id: string; kind: "family" | "student" | null; families: string[]; students: string[] };

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
    ...(r.families.length ? [inArray(said("after", "familyQboId"), r.families), inArray(said("before", "familyQboId"), r.families)] : [])];
  const student = r.kind === "family" ? [] : [eq(said("after", "studentId"), r.id), eq(said("before", "studentId"), r.id),
    ...(r.students.length ? [inArray(said("after", "subjectQboId"), r.students)] : [])];
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
    ...(r.families.length ? (["familyQboId", "fromFamilyQboId", "toFamilyQboId"] as const).map((k) => inArray(said("after", k), r.families))
      .concat([inArray(said("before", "familyQboId"), r.families), subjectAs("family", r.families)]) : [])];
  const student = r.kind === "family" ? [] : [eq(said("after", "studentId"), r.id), eq(said("before", "studentId"), r.id),
    ...(r.students.length ? [subjectAs("student", r.students)] : [])];
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
  const names = [r.id, ...r.families];
  return or(
    and(eq(auditLog.targetType, "parent"), inArray(auditLog.action, ["signin", "signin.refused"]),
      or(eq(said("familyId"), r.id), ...(r.families.length ? [inArray(said("familyQboId"), r.families)] : []))),
    and(eq(auditLog.targetType, "parent"), eq(auditLog.action, "signin.family_switch"), or(inArray(said("from"), names), inArray(said("to"), names))),
    and(inArray(auditLog.action, ["parent.email.request", "parent.email.save"]), eq(said("familyId"), r.id)),
    and(eq(auditLog.targetType, "guardian"), inArray(auditLog.action, ["parent.access.granted", "parent.access.ended"]),
      or(eq(said("familyId"), r.id), ...(r.families.length ? [inArray(said("familyQboId"), r.families)] : []))),
    and(eq(auditLog.targetType, "parent"), eq(auditLog.action, "parent.create"), eq(said("familyId"), r.id)),
  );
}

/**
 * A student's move names both its families in its body, not its target (the student, or before slice 9f the student's
 * customer): the portal's save (`roster.record.moved`: the family left as `before.familyId` and `after.fromFamilyId`,
 * the family joined as `after.familyId`) and its follow-ups (`roster.student.move.followed`: `fromFamilyId` and
 * `toFamilyId` since, the customers `fromFamilyQboId` and `toFamilyQboId` before), and its send to QuickBooks
 * (`roster.student.move`, whose target is the student's customer: where the cache had them before, `before.familyQboId`,
 * and where QuickBooks' answer has them, `after.familyQboId`). A search for either family finds them; a search for the
 * student finds them by their target. Nothing of a student's here.
 */
function moveRowsOf(r: RecordNames): SQL | undefined {
  if (r.kind === "student") return undefined;
  // The key is one of those written here, never a value from the address: written into the query as a text literal.
  type Key = "familyId" | "fromFamilyId" | "toFamilyId" | "fromFamilyQboId" | "toFamilyQboId" | "familyQboId";
  const said = (side: "before" | "after", key: Key) => sql`(${side === "before" ? auditLog.before : auditLog.after}) ->> ${sql.raw(`'${key}'`)}`;
  return or(
    and(eq(auditLog.action, "roster.record.moved"), or(eq(said("before", "familyId"), r.id), eq(said("after", "familyId"), r.id), eq(said("after", "fromFamilyId"), r.id))),
    and(eq(auditLog.action, "roster.student.move.followed"), or(eq(said("after", "fromFamilyId"), r.id), eq(said("after", "toFamilyId"), r.id),
      ...(r.families.length ? [inArray(said("after", "fromFamilyQboId"), r.families), inArray(said("after", "toFamilyQboId"), r.families)] : []))),
    ...(r.families.length ? [and(eq(auditLog.action, "roster.student.move"), or(inArray(said("before", "familyQboId"), r.families), inArray(said("after", "familyQboId"), r.families)))] : []),
  );
}

/**
 * The rows a family or student record's older names find:a row naming one of its customers under a target type that
 * names a customer of that kind (CUSTOMER_TARGET_TYPES), and a tick's or waiver's row, whose target is
 * "<requirement>:<subject>", naming the customer (before the seasons moved) or the record (since).
 */
function recordsOlderNames(r: RecordNames): SQL | undefined {
  const keys = [r.id, ...r.families, ...r.students];
  return or(
    formRowsOf(r),
    buyoutRowsOf(r),
    parentRowsOf(r),
    moveRowsOf(r),
    ...(r.families.length ? [and(inArray(auditLog.targetType, [...CUSTOMER_TARGET_TYPES.family]), inArray(auditLog.targetId, r.families))] : []),
    ...(r.students.length ? [and(inArray(auditLog.targetType, [...CUSTOMER_TARGET_TYPES.student]), inArray(auditLog.targetId, r.students))] : []),
    and(eq(auditLog.targetType, "requirement_progress"), or(...keys.map((k) => sql`${auditLog.targetId} like ${endsWithKey(k)} escape '\\'`))),
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
