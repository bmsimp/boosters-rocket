import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { role, staffUser, roleAssignment, guardian, authProvider, providerCertificate } from "@/lib/db/schema";
import { generateCertificate } from "@/lib/auth/certificate-crypto";
import { isCertificateProvider, type CertificateProviderKey } from "@/lib/auth/certificates";
import { secretBox } from "@/lib/crypto/secret-box";
import { invalidateProviders, type ProviderKey } from "@/lib/auth/providers";
import { eq } from "drizzle-orm";

const TABLES = [
  "audit_log", "role_assignment", "role_rule", "staff_user", "guardian", "setting", "auth_provider", "provider_certificate",
  "staff_auth_session", "staff_auth_account", "staff_auth_verification", "staff_auth_user",
  "parent_auth_session", "parent_auth_account", "parent_auth_verification", "parent_auth_user",
];

/** Empties every table except the built-in Admin role, and removes custom roles. */
export async function resetDb() {
  await db.execute(sql.raw(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`));
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

export async function seedGuardian(opts: { name: string; familyQboId: string; objectId?: string; status?: "invited" | "active" | "disabled" }) {
  const [g] = await db.insert(guardian).values({
    name: opts.name, email: `${opts.name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
    familyQboId: opts.familyQboId, identityObjectId: opts.objectId ?? null, status: opts.status ?? "active",
  }).returning();
  return g!;
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
