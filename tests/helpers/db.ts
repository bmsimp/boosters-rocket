import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { role, staffUser, roleAssignment, guardian, parent, parentAuthUser, parentAuthSession, authProvider, providerCertificate, setting, type GuardianStatus, type DisabledReason } from "@/lib/db/schema";
import { generateCertificate } from "@/lib/auth/certificate-crypto";
import { isCertificateProvider, type CertificateProviderKey } from "@/lib/auth/certificates";
import { secretBox } from "@/lib/crypto/secret-box";
import { invalidateProviders, type ProviderKey } from "@/lib/auth/providers";
import { eq } from "drizzle-orm";
import { mailConfigHash } from "@/lib/mail/config-hash";
import type { StoredMailConfig } from "@/lib/mail/types";

/**
 * Every table in the public schema except "role", read from the database so a new table can't be left out and leak
 * rows between tests. Asked once per process: the schema doesn't change during a run.
 */
let tables: Promise<string[]> | null = null;
function tablesToEmpty(): Promise<string[]> {
  tables ??= db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'role' ORDER BY tablename`)
    .then((rows) => rows.map((r) => r.tablename), (e) => { tables = null; throw e; });
  return tables;
}

/** Empties every table except the built-in Admin role, and removes custom roles. */
export async function resetDb() {
  const names = await tablesToEmpty();
  await db.execute(sql.raw(`TRUNCATE ${names.map((t) => `"${t.replaceAll('"', '""')}"`).join(", ")} RESTART IDENTITY CASCADE`));
  await db.execute(sql`DELETE FROM "role" WHERE "builtin" = false`);
  invalidateProviders();
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

/** A live parent session row, as Better Auth would store it. */
export async function seedParentSession(authUserId: string, o: { familyQboId?: string | null; expiresAt?: Date } = {}) {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  await db.insert(parentAuthSession).values({ id, token, userId: authUserId, familyQboId: o.familyQboId ?? null,
    expiresAt: o.expiresAt ?? new Date(Date.now() + 7 * 86_400_000) });
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
