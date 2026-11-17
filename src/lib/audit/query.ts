import { and, asc, count, desc, eq, gt, gte, lt, lte, max, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

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

function where(f: AuditFilters): SQL | undefined {
  const parts: (SQL | undefined)[] = [];
  if (f.action) parts.push(eq(auditLog.action, f.action));
  if (f.who) parts.push(or(sql`${auditLog.actorLabel} ilike ${likeText(f.who)} escape '\\'`, eq(auditLog.actorId, f.who)));
  if (f.from) parts.push(gte(auditLog.at, f.from));
  if (f.to) parts.push(lt(auditLog.at, f.to));
  if (f.record) {
    parts.push("either" in f.record ? or(eq(auditLog.targetId, f.record.either), eq(auditLog.targetType, f.record.either))
      : and(eq(auditLog.targetType, f.record.type), eq(auditLog.targetId, f.record.id)));
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
  const filter = where(f);
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
  const [r] = await db.select({ n: count(), top: max(auditLog.id) }).from(auditLog).where(where(f));
  return { rows: r?.n ?? 0, upTo: r?.top ?? 0 };
}

/** Every matching row up to `upTo`, newest first, a batch at a time. */
export async function* auditExportRows(f: AuditFilters, upTo: number, batch = 1000): AsyncGenerator<AuditRow[]> {
  let before = upTo + 1;
  for (;;) {
    const rows = await db.select().from(auditLog).where(and(where(f), lt(auditLog.id, before), lte(auditLog.id, upTo))).orderBy(desc(auditLog.id)).limit(batch);
    if (rows.length === 0) return;
    yield rows;
    before = rows.at(-1)!.id;
    if (rows.length < batch) return;
  }
}
