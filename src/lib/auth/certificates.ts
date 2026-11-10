import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { providerCertificate } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { secretBox, SecretBoxError, type SecretBox } from "@/lib/crypto/secret-box";
import { env } from "@/env";
import { generateCertificate, type GeneratedCertificate } from "./certificate-crypto";
import type { ProviderKey } from "./provider-fields";

export type CertificateProviderKey = "staff-microsoft";
export const isCertificateProvider = (key: ProviderKey): key is CertificateProviderKey => key === "staff-microsoft";
export type CertificateRow = typeof providerCertificate.$inferSelect;
export type CertificateView = { id: string; thumbprintSha1: string; thumbprintS256: string; notAfter: Date; createdAt: Date };
export const toCertificateView = (r: CertificateRow): CertificateView =>
  ({ id: r.id, thumbprintSha1: r.thumbprintSha1, thumbprintS256: r.thumbprintS256, notAfter: r.notAfter, createdAt: r.createdAt });

const FILES: Record<CertificateProviderKey, "booster-rocket-staff.cer"> = {
  "staff-microsoft": "booster-rocket-staff.cer",
};
export const certificateFileName = (key: CertificateProviderKey) => FILES[key];
export function certificateKeyForFile(name: string): CertificateProviderKey | null {
  return (Object.keys(FILES) as CertificateProviderKey[]).find((k) => FILES[k] === name) ?? null;
}

const LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('booster.provider_certificate'))`;
const aad = (id: string) => `certificate:${id}`;

export async function certificateRows(key: CertificateProviderKey, tx?: Tx) {
  const rows = await (tx ?? db).select().from(providerCertificate).where(eq(providerCertificate.providerKey, key));
  return { pending: rows.find((r) => r.status === "pending") ?? null, active: rows.find((r) => r.status === "active") ?? null };
}

type CertificateOpts = { actor: Actor; ip: string | null; createdBy: string | null; permission?: string };

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for callers; staff Microsoft is the only certificate provider now
const newCertificate = (key: CertificateProviderKey) => generateCertificate(`Booster Rocket staff (${new URL(env.APP_URL).hostname})`);

async function insertPending(tx: Tx, key: CertificateProviderKey, g: GeneratedCertificate, opts: CertificateOpts): Promise<CertificateRow> {
  const id = crypto.randomUUID();
  const sealed = secretBox().seal(g.privateKeyPem, aad(id));
  const [row] = await tx.insert(providerCertificate).values({
    id, providerKey: key, status: "pending", certificatePem: g.certificatePem, thumbprintS256: g.thumbprintS256,
    thumbprintSha1: g.thumbprintSha1, notAfter: g.notAfter, privateKeyCiphertext: sealed.ciphertext, privateKeyKeyId: sealed.keyId,
    createdBy: opts.createdBy,
  }).returning();
  await writeAudit({ actor: opts.actor, action: "certificate.create", permission: opts.permission, targetType: "provider_certificate", targetId: id,
    after: { providerKey: key, thumbprintSha1: g.thumbprintSha1, notAfter: g.notAfter.toISOString() }, ip: opts.ip }, tx);
  return row!;
}

/** The pending certificate for this sign-in, made (once) if there isn't one. Safe to call repeatedly and concurrently. */
export async function getOrCreatePendingCertificate(key: CertificateProviderKey, opts: CertificateOpts): Promise<CertificateRow> {
  const existing = (await certificateRows(key)).pending;
  if (existing) return existing;
  // Key generation is slow, so it happens before taking the lock; a concurrent winner's row is returned instead.
  const g = await newCertificate(key);
  return db.transaction(async (tx) => {
    await tx.execute(LOCK);
    const raced = (await certificateRows(key, tx)).pending;
    if (raced) return raced;
    return insertPending(tx, key, g, opts);
  });
}

/**
 * **Replace certificate**: a pending certificate to roll out, even when one is active. A pending certificate this server
 * can read is kept (pressing Replace again changes nothing); one it can't read is retired and a new one made in its place.
 */
export async function startCertificateReplacement(key: CertificateProviderKey, opts: CertificateOpts): Promise<CertificateRow> {
  const readable = (r: CertificateRow | null): r is CertificateRow => r !== null && openCertificateKey(r) !== null;
  const existing = (await certificateRows(key)).pending;
  if (readable(existing)) return existing;
  const g = await newCertificate(key);
  return db.transaction(async (tx) => {
    await tx.execute(LOCK);
    const { pending } = await certificateRows(key, tx);
    if (readable(pending)) return pending;
    if (pending) await retire(tx, pending, opts);
    return insertPending(tx, key, g, opts);
  });
}

/** **Discard replacement**: the pending certificate is retired and its key deleted. Null if nothing was pending. */
export async function discardPendingCertificate(key: CertificateProviderKey, opts: { actor: Actor; ip: string | null; permission?: string }): Promise<CertificateRow | null> {
  return db.transaction(async (tx) => {
    await tx.execute(LOCK);
    const { pending } = await certificateRows(key, tx);
    if (!pending) return null;
    await retire(tx, pending, opts, "certificate.discard");
    return pending;
  });
}

/** The decrypted private key (PKCS#8 PEM), or null if it was retired or can't be decrypted with this server's key. */
export function openCertificateKey(row: CertificateRow, box: SecretBox = secretBox()): string | null {
  if (!row.privateKeyCiphertext || !row.privateKeyKeyId) return null;
  try {
    return box.open({ ciphertext: row.privateKeyCiphertext, keyId: row.privateKeyKeyId }, aad(row.id));
  } catch (e) {
    if (e instanceof SecretBoxError) return null;
    throw e;
  }
}

async function retire(tx: Tx, row: CertificateRow, opts: { actor: Actor; ip: string | null; permission?: string }, action = "certificate.retire") {
  await tx.update(providerCertificate).set({ status: "retired", retiredAt: new Date(), privateKeyCiphertext: null, privateKeyKeyId: null })
    .where(eq(providerCertificate.id, row.id));
  await writeAudit({ actor: opts.actor, action, permission: opts.permission, targetType: "provider_certificate", targetId: row.id,
    before: { status: row.status }, after: { providerKey: row.providerKey, thumbprintSha1: row.thumbprintSha1 }, ip: opts.ip }, tx);
}

/** Inside the provider save: the pending certificate becomes active and the previous active one is retired. */
export async function activatePendingCertificate(tx: Tx, key: CertificateProviderKey, opts: {
  actor: Actor; ip: string | null; permission?: string;
}): Promise<CertificateRow | null> {
  await tx.execute(LOCK);
  const { pending, active } = await certificateRows(key, tx);
  if (!pending) return null;
  if (active) await retire(tx, active, opts);
  const [row] = await tx.update(providerCertificate).set({ status: "active", activatedAt: new Date() })
    .where(and(eq(providerCertificate.id, pending.id), eq(providerCertificate.status, "pending"))).returning();
  await writeAudit({ actor: opts.actor, action: "certificate.activate", permission: opts.permission, targetType: "provider_certificate", targetId: pending.id,
    after: { providerKey: key, thumbprintSha1: pending.thumbprintSha1, notAfter: pending.notAfter.toISOString() }, ip: opts.ip }, tx);
  return row ?? null;
}

/** When a Microsoft sign-in is removed: its pending and active certificates are retired and their keys deleted. */
export async function retireCertificates(tx: Tx, key: CertificateProviderKey, opts: { actor: Actor; ip: string | null; permission?: string }) {
  await tx.execute(LOCK);
  const { pending, active } = await certificateRows(key, tx);
  for (const row of [pending, active]) if (row) await retire(tx, row, opts);
}
