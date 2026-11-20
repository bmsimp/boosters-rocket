// Staff only (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts): it reads every person, guardian row, family
// and cached customer at once. Run by the worker alone (src/lib/jobs/runner.ts).
import "server-only";
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, jobRun, parent, qboCustomer, qboCustomerType, setting } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { getShape, missingTypes, ROSTER_LOCK, type MembershipShape } from "@/lib/roster/shape";
import { getRosterSource, ROSTER_JOB } from "@/lib/roster/source";
import { connectedToAnotherCompany, linksOf } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";
import { asShown, type AddressValues } from "./contact-fields";
import { ownRecordIn, whoseDetails, type CachedRecord } from "./my-family";

/**
 * The take-in of a guardian's phone and mailing address (stage 3's slice 11a of the app-owned families spec): once,
 * after the first successful roster read that started after migration 0044, each person (books with a parent type) or
 * family (books with none) is given the details their own QuickBooks record holds, as the roster cache keeps them. After
 * it, nothing QuickBooks holds changes a phone or an address in the portal (stage 4 shows the difference). Its setting
 * is written by migration 0044: `{ after }`, the migration's time, and `doneAt` once it has run.
 */
export const TAKE_IN_KEY = "parents.contact_take_in";
export const TAKE_IN_JOB = "parents.contact_take_in";

type Cached = CachedRecord & {
  addressLine1: string | null; addressLine2: string | null; addressCity: string | null; addressRegion: string | null;
  addressPostalCode: string | null; addressCountry: string | null;
};
/** One set of details to give: the phone and the address, each null when nothing is to be given. */
type Given = { phone: string | null; address: AddressValues | null };

/** The address a cached customer holds, as the form shows one; null when it holds none. */
function addressOf(r: Cached): AddressValues | null {
  const a: AddressValues = { line1: asShown(r.addressLine1 ?? ""), line2: asShown(r.addressLine2 ?? ""), city: asShown(r.addressCity ?? ""),
    region: asShown(r.addressRegion ?? ""), postalCode: asShown(r.addressPostalCode ?? ""), country: asShown(r.addressCountry ?? "") };
  return Object.values(a).some(Boolean) ? a : null;
}
const phoneOf = (r: Cached): string | null => asShown(r.phone ?? "") || null;
const addressKey = (a: AddressValues) => JSON.stringify([a.line1, a.line2, a.city, a.region, a.postalCode, a.country]);

/**
 * One detail across a person's records: the one value they all hold, where every record that holds one holds the same;
 * `disagree` when two hold different ones (left empty, for the person to set); null when none holds one.
 */
function agreed<T>(values: (T | null)[], key: (v: T) => string): T | null | "disagree" {
  const held = values.filter((v): v is T => v !== null);
  if (held.length === 0) return null;
  return new Set(held.map(key)).size === 1 ? held[0]! : "disagree";
}

/** Whether the take-in is waiting to run: its setting is there, not done, and a roster read started after its time succeeded. */
async function waiting(): Promise<boolean> {
  const [row] = await db.select({ value: setting.value }).from(setting).where(eq(setting.key, TAKE_IN_KEY));
  const value = row?.value as { after?: unknown; doneAt?: unknown } | undefined;
  if (!value || value.doneAt !== undefined || typeof value.after !== "string") return false;
  const after = Date.parse(value.after);
  if (Number.isNaN(after)) return false;
  const [read] = await db.select({ id: jobRun.id }).from(jobRun)
    .where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"), gt(jobRun.startedAt, new Date(after)))).orderBy(desc(jobRun.id)).limit(1);
  return read !== undefined;
}

type Plan = {
  people: { id: string; given: Given }[];
  families: { id: AppFamilyId; given: Given }[];
  counts: { peopleWithNoRecord: number; peopleDisagreeing: number };
};

/**
 * What each person and family is to be given, read under the roster lock held shared so no roster read replaces the
 * cache between the reads; null when the take-in must wait (the cache names no company, QuickBooks is connected to
 * another, or the shape doesn't hold). It takes no person's row lock: the writes come after, in a transaction of their
 * own (the lock order above lockedPerson(), src/lib/parents/sessions.ts, takes a person's rows before the roster lock).
 */
async function plan(): Promise<Plan | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
    const [source, other, shape, types] = await Promise.all([getRosterSource(tx), connectedToAnotherCompany(tx), getShape(tx),
      tx.select({ qboId: qboCustomerType.qboId, name: qboCustomerType.name, active: qboCustomerType.active }).from(qboCustomerType)]);
    if (source === null || other || shape === null || missingTypes(shape, types).length > 0) return null;
    const cache: Cached[] = await tx.select({ qboId: qboCustomer.qboId, displayName: qboCustomer.displayName, active: qboCustomer.active,
      parentQboId: qboCustomer.parentQboId, typeQboId: qboCustomer.typeQboId, email: qboCustomer.email, phone: qboCustomer.phone,
      addressLine1: qboCustomer.addressLine1, addressLine2: qboCustomer.addressLine2, addressCity: qboCustomer.addressCity,
      addressRegion: qboCustomer.addressRegion, addressPostalCode: qboCustomer.addressPostalCode, addressCountry: qboCustomer.addressCountry }).from(qboCustomer);
    const byId = new Map(cache.map((c) => [c.qboId, c]));
    const under = new Map<string, Cached[]>();
    for (const c of cache) if (c.parentQboId !== null) under.set(c.parentQboId, [...(under.get(c.parentQboId) ?? []), c]);
    const familyRows = (customer: string): Cached[] => [...(byId.has(customer) ? [byId.get(customer)!] : []), ...(under.get(customer) ?? [])];
    return whoseDetails(shape) === "person" ? planPeople(tx, shape, familyRows) : planFamilies(tx, byId);
  });
}


/** Books with a parent type: each person not yet given details, from the records their open guardian rows sign in from. */
async function planPeople(tx: Tx, shape: MembershipShape, familyRows: (customer: string) => Cached[]): Promise<Plan> {
  const people = await tx.select({ id: parent.id, email: parent.email }).from(parent).where(eq(parent.contactVersion, 0)).orderBy(asc(parent.id));
  const rows = people.length === 0 ? [] : await tx.select({ parentId: guardian.parentId, familyId: guardian.familyId, familyQboId: guardian.familyQboId, sourceQboId: guardian.sourceQboId })
    .from(guardian).innerJoin(family, eq(family.id, guardian.familyId))
    .where(and(ne(guardian.status, "disabled"), eq(family.active, true), inArray(guardian.parentId, people.map((p) => p.id))));
  const families = [...new Set(rows.map((r) => r.familyId).filter((f): f is AppFamilyId => f !== null))];
  const links = await linksOf({ families, students: [] }, tx);
  const out: Plan = { people: [], families: [], counts: { peopleWithNoRecord: 0, peopleDisagreeing: 0 } };
  for (const person of people) {
    // The records the person's sign-in comes from, by the rule myOwnRecord() gives each of their rows (ownRecordIn()):
    // only one whose email field holds their sign-in address, so nobody is given another person's phone or address.
    const records = new Map<string, Cached>();
    for (const row of rows.filter((r) => r.parentId === person.id)) {
      const customer = row.familyId === null ? undefined : links.customerOfFamily.get(row.familyId);
      if (customer === undefined || row.familyQboId !== customer) continue; // the row of that same customer, as the session's must be
      const own = ownRecordIn(shape, customer, familyRows(customer), row.sourceQboId, person.email);
      if (own && own.signsIn && own.edits === "own") records.set(own.row.qboId, own.row);
    }
    if (records.size === 0) { out.counts.peopleWithNoRecord++; continue; }
    const phone = agreed([...records.values()].map(phoneOf), (v) => v);
    const address = agreed([...records.values()].map(addressOf), addressKey);
    const disagreed = phone === "disagree" || address === "disagree";
    if (disagreed) out.counts.peopleDisagreeing++;
    const given: Given = { phone: phone === "disagree" ? null : phone, address: address === "disagree" ? null : address };
    if (given.phone !== null || given.address !== null) out.people.push({ id: person.id, given });
  }
  return out;
}

/** Books with no parent type: each active linked family not yet given details, from its own customer (the family, or the member). */
async function planFamilies(tx: Tx, byId: Map<string, Cached>): Promise<Plan> {
  const families = await tx.select({ id: family.id }).from(family).where(and(eq(family.active, true), eq(family.contactVersion, 0))).orderBy(asc(family.id));
  const links = await linksOf({ families: families.map((f) => f.id), students: [] }, tx);
  const out: Plan = { people: [], families: [], counts: { peopleWithNoRecord: 0, peopleDisagreeing: 0 } };
  for (const f of families) {
    const customer = links.customerOfFamily.get(f.id);
    const row = customer === undefined ? undefined : byId.get(customer);
    if (!row) continue;
    const given: Given = { phone: phoneOf(row), address: addressOf(row) };
    if (given.phone !== null || given.address !== null) out.families.push({ id: f.id, given });
  }
  return out;
}

const columnsOf = (g: Given) => ({
  ...(g.phone !== null ? { phone: g.phone } : {}),
  ...(g.address !== null ? { addressLine1: g.address.line1 || null, addressLine2: g.address.line2 || null, addressCity: g.address.city || null,
    addressRegion: g.address.region || null, addressPostalCode: g.address.postalCode || null, addressCountry: g.address.country || null } : {}),
});

export type TakeInResult = { ran: false } | { ran: true; counts: Record<string, number> };

/**
 * Runs the take-in once, when it is waiting (above) and the cache can be read for it; otherwise it does nothing and is
 * asked again at the next wake. Nothing is read from QuickBooks. Each person's and family's details are written with an
 * update that matches only while their `contact_version` is still 0 (raising it to 1), so a parent's save made meanwhile
 * is never overwritten; the setting's `doneAt` is claimed in that same transaction, so it runs once, with one
 * counts-only audit row (never a name, a number or an address).
 */
export async function takeInContactDetails(): Promise<TakeInResult> {
  if (!(await waiting())) return { ran: false };
  const planned = await plan();
  if (planned === null) return { ran: false };
  return db.transaction(async (tx) => {
    const now = new Date();
    const claimed = await tx.update(setting).set({ value: sql`${setting.value} || ${JSON.stringify({ doneAt: now.toISOString() })}::jsonb`, updatedAt: now })
      .where(and(eq(setting.key, TAKE_IN_KEY), sql`${setting.value}->'doneAt' is null`)).returning({ key: setting.key });
    if (claimed.length === 0) return { ran: false } as const; // another wake ran it meanwhile
    const counts = { peopleGivenPhone: 0, peopleGivenAddress: 0, peopleDisagreeing: planned.counts.peopleDisagreeing, peopleWithNoRecord: planned.counts.peopleWithNoRecord,
      peopleSavedMeanwhile: 0, familiesGivenDetails: 0, familiesSavedMeanwhile: 0 };
    for (const p of planned.people) {
      const done = await tx.update(parent).set({ ...columnsOf(p.given), contactVersion: 1, updatedAt: now })
        .where(and(eq(parent.id, p.id), eq(parent.contactVersion, 0))).returning({ id: parent.id });
      if (done.length === 0) { counts.peopleSavedMeanwhile++; continue; }
      if (p.given.phone !== null) counts.peopleGivenPhone++;
      if (p.given.address !== null) counts.peopleGivenAddress++;
    }
    for (const f of planned.families) {
      const done = await tx.update(family).set({ ...columnsOf(f.given), contactVersion: 1, updatedAt: now })
        .where(and(eq(family.id, f.id), eq(family.contactVersion, 0))).returning({ id: family.id });
      if (done.length === 0) counts.familiesSavedMeanwhile++;
      else counts.familiesGivenDetails++;
    }
    await writeAudit({ actor: { door: "system", id: null, label: "worker" }, action: "parent.details.taken_in", targetType: "setting", targetId: TAKE_IN_KEY, after: counts }, tx);
    return { ran: true, counts } as const;
  });
}
