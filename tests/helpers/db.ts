import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { role, staffUser, roleAssignment, family, guardian, parent, parentAuthUser, parentAuthSession, authProvider, providerCertificate, setting, type GuardianStatus, type DisabledReason } from "@/lib/db/schema";
import { generateCertificate } from "@/lib/auth/certificate-crypto";
import { isCertificateProvider, type CertificateProviderKey } from "@/lib/auth/certificates";
import { secretBox } from "@/lib/crypto/secret-box";
import { invalidateProviders, type ProviderKey } from "@/lib/auth/providers";
import { and, eq, isNotNull } from "drizzle-orm";
import { mailConfigHash } from "@/lib/mail/config-hash";
import type { StoredMailConfig } from "@/lib/mail/types";
import type { AppFamilyId } from "@/lib/families/ids";
import { getRosterSource } from "@/lib/roster/source";
import { recordOfCustomer } from "./app-records";

/**
 * How to empty the database, worked out once per process from the database itself (the schema doesn't change during a
 * run), so a new table can't be left out and leak rows between tests. One statement, one trip to the server:
 * every table in the public schema except "role" is locked and emptied, the sequences those tables own start again,
 * and custom roles are removed.
 *
 * The rows are deleted, not truncated. TRUNCATE gives every table and index a new file on disk, which took most of a
 * second here on each reset, two thousand times a run; deleting a test's few rows takes a couple of milliseconds. The
 * lock is the one TRUNCATE took: the reset waits for anything a test left running to finish its transaction, then
 * removes what it wrote too.
 *
 * A table emptied by DELETE keeps its pages, though, and Postgres puts later rows wherever it has noted room, not
 * after the rows before them. Many tests read rows back with no ORDER BY and take the first or the last as the one
 * written first or last; on a table that keeps its pages they fail now and then. So resetDb() then vacuums the tables
 * the test wrote, which hands their emptied pages back to the disk: each starts again from no pages, and rows lie in
 * the order they were written, as after a TRUNCATE. That costs about 10 ms a table the test wrote, against some 40 ms
 * for TRUNCATE, which also has to empty every table that refers to one it empties.
 */
let emptying: Promise<string> | null = null;
function emptyEverything(): Promise<string> {
  emptying ??= howToEmpty().catch((e: unknown) => { emptying = null; throw e; });
  return emptying;
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** The tables, but for "role", that have pages on disk: those written since they were last emptied to nothing. */
async function writtenTables(): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`SELECT c.oid::regclass::text AS name FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> 'role' AND pg_relation_size(c.oid) > 0 ORDER BY 1`);
  return rows.map((t) => t.name);
}

async function howToEmpty(): Promise<string> {
  const tables = await db.execute<{ id: number; name: string }>(sql`SELECT c.oid::int AS id, c.relname AS name FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname <> 'role' ORDER BY c.relname`);
  const references = await db.execute<{ child: number; parent: number }>(sql`SELECT conrelid::int AS child, confrelid::int AS parent FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND conrelid <> confrelid`);
  const sequences = await db.execute<{ name: string; start: string }>(sql`SELECT s.relname AS name, q.seqstart::text AS start
    FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S' JOIN pg_sequence q ON q.seqrelid = s.oid JOIN pg_class t ON t.oid = d.refobjid
    WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      AND t.relnamespace = 'public'::regnamespace AND t.relkind IN ('r', 'p') AND t.relname <> 'role' ORDER BY s.relname`);
  const names = tables.map((t) => quoted(t.name));
  const customRoles = `DELETE FROM "role" WHERE "builtin" = false`;
  if (names.length === 0) return customRoles;
  const order = childrenFirst(tables.map((t) => t.id), [...references]);
  // Tables that can't be emptied one by one are truncated together, as every reset once did.
  if (!order) return [`TRUNCATE ${names.join(", ")} RESTART IDENTITY CASCADE`, customRoles].join("; ");
  const nameOf = new Map(tables.map((t) => [t.id, quoted(t.name)]));
  return [
    `LOCK TABLE ${names.join(", ")} IN ACCESS EXCLUSIVE MODE`,
    ...order.map((id) => `DELETE FROM ${nameOf.get(id)!}`),
    ...sequences.map((q) => `PERFORM setval('public.${quoted(q.name).replaceAll("'", "''")}'::regclass, ${BigInt(q.start)}, false)`),
    customRoles,
  ].join("; ");
}

/**
 * The tables in an order where each comes before every table it refers to, or null when there is no such order: they
 * refer to each other in a circle, or a table that is not being emptied refers to one that is.
 */
export function childrenFirst(ids: number[], references: { child: number; parent: number }[]): number[] | null {
  const waitingOn = new Map(ids.map((id) => [id, new Set<number>()])); // parent -> the children still to be emptied
  for (const { child, parent } of references) {
    if (!waitingOn.has(parent)) continue;
    if (!waitingOn.has(child)) return null;
    waitingOn.get(parent)!.add(child);
  }
  const order: number[] = [];
  while (order.length < ids.length) {
    const free = ids.filter((id) => waitingOn.has(id) && waitingOn.get(id)!.size === 0);
    if (free.length === 0) return null;
    for (const id of free) { order.push(id); waitingOn.delete(id); }
    for (const children of waitingOn.values()) for (const id of free) children.delete(id);
  }
  return order;
}

/** Empties every table except the built-in Admin role, removes custom roles, and starts identity columns again from 1. */
export async function resetDb() {
  const statements = await emptyEverything();
  // A DO block is one statement and one transaction, whatever protocol the driver speaks.
  await db.execute(sql.raw(`DO $reset$ BEGIN ${statements}; END $reset$`));
  // Then the tables the test wrote give their pages back (see above). VACUUM can't run inside a transaction, so it is a
  // statement of its own; it takes the tables one after another, as at once they kept each other's rows from going.
  let written = await writtenTables();
  if (written.length) await db.execute(sql.raw(`VACUUM (INDEX_CLEANUP ON, TRUNCATE ON, PROCESS_TOAST OFF, SKIP_DATABASE_STATS) ${written.join(", ")}`));
  // A transaction left open somewhere can keep the deleted rows from going. Those few tables are truncated instead.
  if (written.length) written = await writtenTables();
  if (written.length) {
    await db.execute(sql.raw(`DO $reset$ BEGIN PERFORM set_config('client_min_messages', 'warning', true);
      EXECUTE ${literal(`TRUNCATE ${written.join(", ")} CASCADE`)}; END $reset$`));
  }
  invalidateProviders();
}

/**
 * Resolves once another session on this file's database is waiting for a lock (a row, a table, an advisory lock): for a
 * test that proves one piece of work waits for another. A sleep guesses how long the second takes to reach the lock,
 * and on a loaded machine guesses short; this asks Postgres. Only this file uses its database, so the waiter is the
 * test's own. `waiters` is how many sessions must be waiting at once, for a test that starts several.
 */
export async function untilALockIsAwaited(timeoutMs = 15_000, waiters = 1): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`);
    if (row!.n >= waiters) return;
    if (Date.now() > until) throw new Error(waiters === 1 ? `Nothing was waiting for a lock after ${timeoutMs} ms.` : `Fewer than ${waiters} sessions were waiting for a lock after ${timeoutMs} ms.`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function adminRoleId(): Promise<string> {
  const [r] = await db.select().from(role).where(eq(role.key, "admin"));
  if (!r) throw new Error("admin role missing — migrations not applied");
  return r.id;
}

export async function seedStaff(opts: { email: string; name?: string; status?: "invited" | "active" | "disabled"; admin?: boolean }) {
  const [s] = await db.insert(staffUser).values({
    email: opts.email.trim().toLowerCase(),
    name: opts.name ?? opts.email,
    status: opts.status ?? "active",
  }).returning();
  if (opts.admin) await db.insert(roleAssignment).values({ roleId: await adminRoleId(), staffUserId: s!.id });
  return s!;
}

export type ParentRow = typeof parent.$inferSelect;
export type GuardianRow = typeof guardian.$inferSelect;

export async function seedParent(o: { name: string; email?: string; phone?: string | null; blocked?: boolean; welcomedAt?: Date | null; welcomeOwed?: boolean }): Promise<ParentRow & { authUserId: string }> {
  const email = (o.email ?? `${o.name.toLowerCase().replace(/\s+/g, ".")}@example.com`).trim().toLowerCase();
  const [p] = await db.insert(parent).values({ name: o.name, email, phone: o.phone ?? null, blocked: o.blocked ?? false, welcomedAt: o.welcomedAt ?? null, welcomeOwed: o.welcomeOwed ?? false }).returning();
  const [u] = await db.insert(parentAuthUser).values({ id: crypto.randomUUID(), name: o.name, email, emailVerified: true, parentId: p!.id }).returning();
  return { ...p!, authUserId: u!.id };
}

export async function seedGuardian(o: {
  parentId: string; familyQboId: string; status?: GuardianStatus; isPrimary?: boolean;
  disabledReason?: DisabledReason | null; statusBeforeDisable?: "invited" | "active" | null; sourceQboId?: string | null;
}): Promise<GuardianRow> {
  const [g] = await db.insert(guardian).values({
    parentId: o.parentId, familyQboId: o.familyQboId, status: o.status ?? "active", isPrimary: o.isPrimary ?? false,
    disabledReason: o.disabledReason ?? null, statusBeforeDisable: o.statusBeforeDisable ?? null, sourceQboId: o.sourceQboId ?? null,
  }).returning();
  return g!;
}

/**
 * A guardian row (seedGuardian()) in an active family record of the app's own, with no link to QuickBooks: a family the
 * gate lets its person into (an open row naming an active family record, src/lib/auth/resolve.ts), for the tests of the
 * door that seed people by hand with no roster company. Rows of one `familyQboId` share one record, as the session's
 * stored family id is matched to a row by it. A test with a roster company imports the records instead
 * (syncAppRecords()), which would point these rows elsewhere.
 */
export async function seedGuardianInFamily(o: Parameters<typeof seedGuardian>[0]): Promise<GuardianRow> {
  const [same] = await db.select({ familyId: guardian.familyId }).from(guardian)
    .where(and(eq(guardian.familyQboId, o.familyQboId), isNotNull(guardian.familyId))).limit(1);
  const familyId = same?.familyId ?? (await db.insert(family).values({ name: null, active: true }).returning({ id: family.id }))[0]!.id;
  const g = await seedGuardian(o);
  const [row] = await db.update(guardian).set({ familyId }).where(eq(guardian.id, g.id)).returning();
  return row!;
}

/**
 * The app's own family a session in `familyQboId` stores, as migration 0037 carried one over: the family record of the
 * person's own guardian row in that family, when it names one; else, while the roster names a company, that
 * customer's family record (recordOfCustomer(), which a later step points the row at too). Throws when there is none,
 * rather than store a session that names no family: a test of the door seeds its rows with seedGuardianInFamily().
 */
export async function familyOfSession(authUserId: string, familyQboId: string): Promise<AppFamilyId> {
  const [row] = await db.select({ familyId: guardian.familyId }).from(guardian).innerJoin(parentAuthUser, eq(parentAuthUser.parentId, guardian.parentId))
    .where(and(eq(parentAuthUser.id, authUserId), eq(guardian.familyQboId, familyQboId), isNotNull(guardian.familyId)));
  if (row?.familyId) return row.familyId;
  if ((await getRosterSource()) !== null) return recordOfCustomer(familyQboId, "family");
  throw new Error(`seedParentSession: no family record for ${familyQboId}: the person has no row in it naming one and the roster names no company. Seed the row with seedGuardianInFamily(), or a roster company first.`);
}

/**
 * A live parent session row, as Better Auth would store it. Its family is the app's own record (`familyId`), or the one
 * a family's QuickBooks id comes to (familyOfSession()); neither, a session still choosing.
 */
export async function seedParentSession(authUserId: string, o: { familyQboId?: string | null; familyId?: AppFamilyId | null; expiresAt?: Date; strongAt?: Date | null;
  deviceId?: string | null } = {}) {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const familyId = o.familyId ?? (o.familyQboId ? await familyOfSession(authUserId, o.familyQboId) : null);
  // `strongAt`: when the session last proved the password and the second step (a sign-in, or asking again: slice
  // SI-5a). Null, as for a session made before the password release, unless given. `deviceId`: the remembered device
  // (`parent_device`, seedDevice()) the session was made on (slice SI-5b), which its renewal renews and the sign-in
  // settings mark as "This device"; null, as for a session made before SI-5b, unless given.
  await db.insert(parentAuthSession).values({ id, token, userId: authUserId, familyId,
    expiresAt: o.expiresAt ?? new Date(Date.now() + 7 * 86_400_000), strongAt: o.strongAt ?? null, deviceId: o.deviceId ?? null });
  return { id, token };
}

export async function seedCertificate(key: CertificateProviderKey, status: "pending" | "active") {
  const g = await generateCertificate(`seed ${key}`);
  const id = crypto.randomUUID();
  const sealed = secretBox().seal(g.privateKeyPem, `certificate:${id}`);
  const [row] = await db.insert(providerCertificate).values({
    id, providerKey: key, status, certificatePem: g.certificatePem, thumbprintS256: g.thumbprintS256, thumbprintSha1: g.thumbprintSha1,
    notAfter: g.notAfter, privateKeyCiphertext: sealed.ciphertext, privateKeyKeyId: sealed.keyId, activatedAt: status === "active" ? new Date() : null,
  }).returning();
  invalidateProviders();
  return row!;
}

export async function seedProvider(key: ProviderKey, config: Record<string, string>, secret = "seeded-secret", expiresAt: Date | null = null) {
  if (isCertificateProvider(key)) {
    await db.insert(authProvider).values({ key, config, secretCiphertext: null, secretKeyId: null, secretExpiresAt: expiresAt });
    await seedCertificate(key, "active");
    return;
  }
  const sealed = secretBox().seal(secret, key);
  await db.insert(authProvider).values({ key, config, secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId, secretExpiresAt: expiresAt });
  invalidateProviders();
}

/** Mail settings that count as working (a test send recorded for exactly these settings). */
export async function seedWorkingMail(config: StoredMailConfig = { method: "graph", mailbox: "webmaster@example.org" }) {
  const status = { verifiedHash: mailConfigHash(config), verifiedAt: new Date().toISOString(), lastSuccessAt: null, lastFailureAt: null, lastError: null };
  await db.insert(setting).values([{ key: "mail", value: config }, { key: "mail.status", value: status }]);
}
