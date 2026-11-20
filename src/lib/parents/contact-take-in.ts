// Staff only (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts): it reads every person, guardian row, family
// and cached customer at once. Run by the worker alone (src/lib/jobs/runner.ts).
import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, qboCustomer, qboCustomerType, setting } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { getShape, missingTypes, ROSTER_LOCK, shapeHolds, type MembershipShape } from "@/lib/roster/shape";
import { TAKE_IN_KEY } from "./take-in-setting";
import { getRosterSource } from "@/lib/roster/source";
import { connectedToAnotherCompany, linksOf } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";
import { asShown, detailKey, type AddressValues } from "./contact-fields";
import { ownRecordIn, whoseDetails, type CachedRecord } from "./my-family";

/**
 * The take-in of a guardian's phone and mailing address (stage 3's slice 11a of the app-owned families spec): once,
 * after the first successful roster read since migration 0044 made by a build that keeps the billing address in the
 * cache, each person (books with a parent type) or family (books with none) is given the details their own QuickBooks
 * record holds, as the roster cache keeps them. After it, nothing QuickBooks holds changes a phone or an address in the
 * portal (stage 4 shows the difference). Its setting is written by migration 0044 as `{ after }`, the migration's
 * time; a roster read made under a shape that holds adds `addressesReadAt` (noteAddressesKept()), and a shape save
 * withdraws it (withdrawAddressesNote(), ./take-in-setting.ts); the worker's own ask for such a read adds
 * `readAskedAt` (takeInAsksForARead()); and the take-in `doneAt` once it has run.
 */
export { TAKE_IN_KEY };
export const TAKE_IN_JOB = "parents.contact_take_in";
/** How often, at most, the take-in asks the worker for a roster read while none has kept the addresses: a broken connection is not hammered. */
export const TAKE_IN_ASK_EVERY_MS = 3_600_000;

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

/**
 * One detail across a person's records: the value every one of them holds, where they all hold the same by the one
 * normal form a phone or an address is compared by (detailKey(), shared with the change sent on to QuickBooks, so a
 * detail copied here is never held back there for a difference of spacing, letter case or an empty line); `disagree`
 * when they don't, a record that holds none beside one that holds one included (left empty, for the person to set:
 * the club may have left it out of that record on purpose); null when none holds one.
 */
function agreed<T extends string | AddressValues>(values: (T | null)[]): T | null | "disagree" {
  if (values.length === 0) return null;
  return new Set(values.map((v) => detailKey(v))).size === 1 ? values[0]! : "disagree";
}

/**
 * Notes, in the savepoint that saves a successful roster read (refreshRoster(), src/lib/roster/refresh.ts), that the
 * cache now holds the billing addresses this build keeps, at the read's start: the take-in waits for it. A successful
 * read is not enough by itself: the build before migration 0044 answers the roster read the migration asks for too,
 * and while it still runs beside the migrated database (scripts/poc/deploy.sh migrates before it replaces the app) its
 * read leaves every address empty, so the take-in would run once over a cache that holds none. Nothing once the
 * take-in has run, or where the migration wrote no setting. Nor while the shape doesn't hold (none, or one naming a
 * type the read didn't find in QuickBooks): such a read kept the addresses only of the types it names, so once an
 * Admin chooses a shape that holds the take-in waits for a read made under it (a shape save withdraws a note too).
 */
export async function noteAddressesKept(tx: Tx, readAt: Date): Promise<void> {
  if (!(await shapeHolds(tx))) return;
  await tx.update(setting).set({ value: sql`${setting.value} || ${JSON.stringify({ addressesReadAt: readAt.toISOString() })}::jsonb`, updatedAt: new Date() })
    .where(and(eq(setting.key, TAKE_IN_KEY), sql`${setting.value}->'doneAt' is null`));
}

/**
 * Whether the take-in is waiting to run: its setting is there, not done, and a roster read that kept the billing
 * addresses (noteAddressesKept()) started after the migration's time.
 */
async function waiting(): Promise<boolean> {
  const value = readSetting(await settingValue());
  return value !== null && value.noted;
}

type TakeInSetting = { noted: boolean; addressesReadAt: string | null; readAskedAt: number | null; raw: unknown };
const settingValue = async (tx: Tx | typeof db = db): Promise<unknown> => (await tx.select({ value: setting.value }).from(setting).where(eq(setting.key, TAKE_IN_KEY)))[0]?.value;
/** The setting while the take-in has not run (null once it has, or where there is none): whether a read that kept the addresses is noted. */
function readSetting(raw: unknown): TakeInSetting | null {
  const value = raw as { after?: unknown; addressesReadAt?: unknown; readAskedAt?: unknown; doneAt?: unknown } | undefined;
  if (!value || typeof value !== "object" || value.doneAt !== undefined || typeof value.after !== "string") return null;
  const after = Date.parse(value.after);
  if (Number.isNaN(after)) return null;
  const read = typeof value.addressesReadAt === "string" ? Date.parse(value.addressesReadAt) : NaN;
  const asked = typeof value.readAskedAt === "string" ? Date.parse(value.readAskedAt) : NaN;
  const noted = !Number.isNaN(read) && read > after;
  return { noted, addressesReadAt: noted ? (value.addressesReadAt as string) : null, readAskedAt: Number.isNaN(asked) ? null : asked, raw };
}

/**
 * Whether the worker is to read the roster at this wake for the take-in, the one place that decides it (called by
 * runDueJobs(), src/lib/jobs/runner.ts, while QuickBooks is connected): while the take-in has not run and no read
 * that kept the addresses is noted, a read is treated as asked for, whatever the build before migration 0044 answered
 * to the migration's own ask (its read keeps no address and notes nothing). So the first wake of this build reads at
 * once, and while reads fail, or succeed under a shape that doesn't hold, it asks again no more often than once an
 * hour (TAKE_IN_ASK_EVERY_MS). Each ask is claimed in the setting (`readAskedAt`), so two wakes at once ask once.
 */
export async function takeInAsksForARead(now: Date = new Date()): Promise<boolean> {
  const value = readSetting(await settingValue());
  if (value === null || value.noted) return false;
  if (value.readAskedAt !== null && now.getTime() - value.readAskedAt < TAKE_IN_ASK_EVERY_MS) return false;
  const claimed = await db.update(setting).set({ value: sql`${setting.value} || ${JSON.stringify({ readAskedAt: now.toISOString() })}::jsonb`, updatedAt: new Date() })
    .where(and(eq(setting.key, TAKE_IN_KEY), sql`${setting.value} = ${JSON.stringify(value.raw)}::jsonb`)).returning({ key: setting.key });
  return claimed.length > 0;
}

/**
 * What the take-in is waiting for: QuickBooks connected, the connection mended, QuickBooks connected to the roster's
 * company, the membership shape, or a roster read; or only the worker's next wake, after a read that kept the addresses.
 */
export type TakeInWait = "connect" | "mend" | "other_company" | "shape" | "read" | "next_wake";

/**
 * Why the take-in has not run yet, for the Health page's QuickBooks line (src/lib/health/report.ts); null once it has
 * run, or where migration 0044 wrote no setting. `conn` is the connection as that page read it.
 */
export async function takeInWaitingFor(conn: { configured: boolean; connected: boolean; needsAdmin: boolean }): Promise<TakeInWait | null> {
  const value = readSetting(await settingValue());
  if (value === null) return null;
  if (await connectedToAnotherCompany()) return "other_company";
  const holds = await shapeHolds();
  // A read under this shape kept the addresses: the take-in reads the cache, not QuickBooks, at the next wake.
  if (value.noted && holds && (await getRosterSource()) !== null) return "next_wake";
  if (!conn.configured || !conn.connected) return "connect";
  if (conn.needsAdmin) return "mend";
  return holds ? "read" : "shape";
}

const WAIT_WORDS: Record<TakeInWait, string> = {
  connect: "It copies them once an Admin connects QuickBooks and the roster has been read.",
  mend: "It copies them once an Admin connects QuickBooks again, as above, and the roster has been read.",
  other_company: "It copies them once QuickBooks is connected to the company the roster was read from, as above, and the roster has been read.",
  shape: "It copies them once the membership shape names only customer types QuickBooks has, at the roster read after the shape is saved.",
  read: "It copies them after the worker's next successful read of the roster, which it tries at once and then once an hour until one works.",
  next_wake: "The roster has been read, so the worker copies them when it next wakes, within a minute.",
};

/** The Health page's note while the take-in has not run, in words. */
export function takeInWaitWords(wait: TakeInWait): string {
  return `Parents' phones and mailing addresses haven't been copied from QuickBooks into the portal yet. ${WAIT_WORDS[wait]} Meanwhile a parent can type their own on their Family page, and the copy never replaces what a parent has typed.`;
}

export type TakeInPlan = {
  /** The note the plan was made under (`addressesReadAt`, as stored): the write claims `doneAt` only while it still stands. */
  notedAt: string;
  people: { id: string; given: Given }[];
  families: { id: AppFamilyId; given: Given }[];
  counts: { peopleWithNoRecord: number; peopleDisagreeing: number };
};

/**
 * What each person and family is to be given, read under the roster lock held shared so no roster read replaces the
 * cache, and no shape save the shape, between the reads; null when the take-in must wait (the note that a read kept the
 * addresses is not there, read again under the lock, since a shape save withdraws it under the roster lock held
 * exclusively and may have committed since the caller looked; the cache names no company, QuickBooks is connected to
 * another, or the shape doesn't hold). It takes no person's row lock: the writes come after, in a transaction of their
 * own (the lock order above lockedPerson(), src/lib/parents/sessions.ts, takes a person's rows before the roster lock).
 */
export async function planContactTakeIn(): Promise<TakeInPlan | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
    const note = readSetting(await settingValue(tx));
    if (note === null || note.addressesReadAt === null) return null;
    const notedAt = note.addressesReadAt;
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
    const plan = whoseDetails(shape) === "person" ? await planPeople(tx, shape, familyRows) : await planFamilies(tx, byId);
    return { notedAt, ...plan };
  });
}


/** Books with a parent type: each person not yet given details, from the records their open guardian rows sign in from. */
async function planPeople(tx: Tx, shape: MembershipShape, familyRows: (customer: string) => Cached[]): Promise<Omit<TakeInPlan, "notedAt">> {
  const people = await tx.select({ id: parent.id, email: parent.email }).from(parent).where(eq(parent.contactVersion, 0)).orderBy(asc(parent.id));
  const rows = people.length === 0 ? [] : await tx.select({ parentId: guardian.parentId, familyId: guardian.familyId, familyQboId: guardian.familyQboId, sourceQboId: guardian.sourceQboId })
    .from(guardian).innerJoin(family, eq(family.id, guardian.familyId))
    .where(and(ne(guardian.status, "disabled"), eq(family.active, true), inArray(guardian.parentId, people.map((p) => p.id))));
  const families = [...new Set(rows.map((r) => r.familyId).filter((f): f is AppFamilyId => f !== null))];
  const links = await linksOf({ families, students: [] }, tx);
  const out: Omit<TakeInPlan, "notedAt"> = { people: [], families: [], counts: { peopleWithNoRecord: 0, peopleDisagreeing: 0 } };
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
    const phone = agreed([...records.values()].map(phoneOf));
    const address = agreed([...records.values()].map(addressOf));
    const disagreed = phone === "disagree" || address === "disagree";
    if (disagreed) out.counts.peopleDisagreeing++;
    const given: Given = { phone: phone === "disagree" ? null : phone, address: address === "disagree" ? null : address };
    if (given.phone !== null || given.address !== null) out.people.push({ id: person.id, given });
  }
  return out;
}

/** Books with no parent type: each active linked family not yet given details, from its own customer (the family, or the member). */
async function planFamilies(tx: Tx, byId: Map<string, Cached>): Promise<Omit<TakeInPlan, "notedAt">> {
  const families = await tx.select({ id: family.id }).from(family).where(and(eq(family.active, true), eq(family.contactVersion, 0))).orderBy(asc(family.id));
  const links = await linksOf({ families: families.map((f) => f.id), students: [] }, tx);
  const out: Omit<TakeInPlan, "notedAt"> = { people: [], families: [], counts: { peopleWithNoRecord: 0, peopleDisagreeing: 0 } };
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
  const planned = await planContactTakeIn();
  if (planned === null) return { ran: false };
  return writeContactTakeIn(planned);
}

/**
 * The take-in's writes, from what planContactTakeIn() read (apart from it so that a test can save a parent's details
 * between the two): the setting's `doneAt` claimed, only while the note the plan was made under still stands (a shape
 * save that committed since withdrew it, and the plan may give details by the old shape's rule), each person's and family's details only while their
 * `contact_version` is still 0, and its audit row, in one transaction.
 */
export async function writeContactTakeIn(planned: TakeInPlan): Promise<TakeInResult> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const claimed = await tx.update(setting).set({ value: sql`${setting.value} || ${JSON.stringify({ doneAt: now.toISOString() })}::jsonb`, updatedAt: now })
      .where(and(eq(setting.key, TAKE_IN_KEY), sql`${setting.value}->'doneAt' is null`, sql`${setting.value}->>'addressesReadAt' = ${planned.notedAt}`))
      .returning({ key: setting.key });
    // Another wake ran it meanwhile, or a shape save withdrew the note: it waits for a read under the saved shape.
    if (claimed.length === 0) return { ran: false } as const;
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
