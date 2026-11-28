import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { backupFile, backupRequest, setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { secretBox, type SealedSecret } from "@/lib/crypto/secret-box";
import { env } from "@/env";
import { BACKUPS_PERMISSION, STAMP } from "./status";
import { putObject, type Storage } from "./s3";

/**
 * Off-site copies of backups (docs/superpowers/specs/2026-11-28-in-app-backups-design.md, section 6): optional, off until
 * an Admin sets them up, to any S3-compatible storage (no provider is named). The setting backup.offsite holds the
 * storage's address, region, bucket and folder, the access key's ID, and, sealed by secretBox(), its secret and the
 * passphrase the copies are encrypted with; `on` is all the agent reads of it. Nothing sealed is ever returned to a page.
 * Each copy is encrypted as it streams up, in OpenSSL's own format, so the standard `openssl` tool opens it.
 */
export const OFFSITE_KEY = "backup.offsite";
export const PBKDF2_ITER = 600_000;
export const OPENSSL_DECRYPT = `openssl enc -d -aes-256-cbc -pbkdf2 -iter ${PBKDF2_ITER} -md sha256 -in <copy> -out backup.tar`;
const SECRET_AAD = "backup.offsite.secret", PASS_AAD = "backup.offsite.passphrase";
const TEST_KEY = "boosters-rocket-connection-test.txt";

type Stored = {
  on: true; endpoint: string; region: string; bucket: string; folder: string; accessKeyId: string;
  secret: SealedSecret; passphrase: SealedSecret; lastTest?: { at: string; ok: boolean };
};
/** What a page may be shown: never a secret, and only the key ID's last four characters. */
export type OffsiteView = { endpoint: string; region: string; bucket: string; folder: string; keyEnd: string; lastTest: { at: string; ok: boolean } | null };
export type Draft = { endpoint: string; region: string; bucket: string; folder: string; accessKeyId: string; secret: string | null };
type Who = { actor: Actor; ip: string | null };
type Done = { ok: true; message: string } | { ok: false; errors: string[] };

const sealed = (v: unknown): v is SealedSecret => typeof v === "object" && v !== null && typeof (v as SealedSecret).ciphertext === "string" && typeof (v as SealedSecret).keyId === "string";

async function readStored(tx: Tx | typeof db = db, lock = false): Promise<Stored | null> {
  const q = tx.select({ value: setting.value }).from(setting).where(eq(setting.key, OFFSITE_KEY));
  const [row] = lock ? await q.for("update") : await q;
  const v = row?.value as Partial<Stored> | undefined;
  if (!v || v.on !== true || typeof v.endpoint !== "string" || typeof v.bucket !== "string" || typeof v.region !== "string"
    || typeof v.folder !== "string" || typeof v.accessKeyId !== "string" || !sealed(v.secret) || !sealed(v.passphrase)) return null;
  return v as Stored;
}

/** Off-site storage as a page may show it, or null while off-site copies are off. */
export async function readOffsite(): Promise<OffsiteView | null> {
  const s = await readStored();
  return s ? { endpoint: s.endpoint, region: s.region, bucket: s.bucket, folder: s.folder, keyEnd: s.accessKeyId.slice(-4), lastTest: s.lastTest ?? null } : null;
}

/** The form's fields, as strings. */
export function offsiteFields(form: FormData) {
  const get = (k: string) => { const v = form.get(k); return typeof v === "string" ? v : ""; };
  return { endpoint: get("endpoint"), region: get("region"), bucket: get("bucket"), folder: get("folder"), accessKeyId: get("accessKeyId"), secret: get("secret") };
}

/** The storage's address: https, or http to this machine alone; its origin, nothing more. */
export function storageAddress(v: string): string | null {
  try {
    const u = new URL(v.trim());
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    return u.origin;
  } catch { return null; }
}

/** The off-site form, checked. A blank secret keeps the saved one (only when one is saved). */
export function parseOffsite(f: ReturnType<typeof offsiteFields>, hasSaved: boolean): { ok: true; draft: Draft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const endpoint = storageAddress(f.endpoint);
  if (!endpoint) errors.push("Enter the storage's address, starting with https://, with nothing after the name.");
  const region = f.region.trim() || "auto";
  if (!/^[a-z0-9-]{1,32}$/.test(region)) errors.push("Enter the region as the storage writes it, such as us-east-1, or auto.");
  const bucket = f.bucket.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) errors.push("Enter the bucket's name: lower-case letters, digits, dots and hyphens.");
  const folder = f.folder.trim().replace(/^\/+|\/+$/g, "");
  if (folder.length > 200 || !/^([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)?$/.test(folder)) errors.push("A folder is letters, digits, dots, hyphens and underscores, parted by /. Leave it blank for none.");
  const accessKeyId = f.accessKeyId.trim();
  if (!/^[A-Za-z0-9+/=_.-]{4,128}$/.test(accessKeyId)) errors.push("Enter the access key ID.");
  const secret = f.secret.trim();
  if (secret === "" && !hasSaved) errors.push("Enter the secret access key.");
  else if (secret !== "" && !/^[\x21-\x7e]{8,256}$/.test(secret)) errors.push("The secret access key doesn't look right: check it was copied whole.");
  return errors.length ? { ok: false, errors } : { ok: true, draft: { endpoint: endpoint!, region, bucket, folder, accessKeyId, secret: secret || null } };
}

const shown = (s: Pick<Stored, "endpoint" | "region" | "bucket" | "folder" | "accessKeyId"> | null) =>
  s && { endpoint: s.endpoint, region: s.region, bucket: s.bucket, folder: s.folder, keyEnd: s.accessKeyId.slice(-4) };

/**
 * Sets off-site copies up, or changes them, audited without any secret. The first set-up makes the copies' passphrase,
 * which the answer shows once and nothing shows again; a change keeps it.
 */
export async function saveOffsite(d: Draft, who: Who): Promise<Done> {
  const box = secretBox();
  return db.transaction(async (tx) => {
    const before = await readStored(tx, true);
    if (d.secret === null && !before) return { ok: false as const, errors: ["Enter the secret access key."] };
    const fresh = before ? null : randomBytes(24).toString("base64url");
    const value: Stored = {
      on: true, endpoint: d.endpoint, region: d.region, bucket: d.bucket, folder: d.folder, accessKeyId: d.accessKeyId,
      secret: d.secret !== null ? box.seal(d.secret, SECRET_AAD) : before!.secret,
      passphrase: fresh !== null ? box.seal(fresh, PASS_AAD) : before!.passphrase,
    };
    await tx.insert(setting).values({ key: OFFSITE_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
    await writeAudit({ actor: who.actor, action: "backup.offsite.update", permission: BACKUPS_PERMISSION, targetType: "setting", targetId: OFFSITE_KEY,
      before: shown(before), after: { ...shown(value), secretChanged: d.secret !== null }, ip: who.ip }, tx);
    return { ok: true as const, message: fresh !== null
      ? `Saved. Off-site copies are on, from the next backup. The passphrase for these copies is ${fresh}. Keep this with the env file. Without it, these copies can't be opened. It isn't shown again.`
      : "Saved. Off-site copies use these settings from the next backup." };
  });
}

/** Stops off-site copies, forgetting the settings. Copies already in the storage stay. */
export async function stopOffsite(who: Who): Promise<Done> {
  return db.transaction(async (tx) => {
    const before = await readStored(tx, true);
    if (!before) return { ok: true as const, message: "Off-site copies are already off." };
    await tx.delete(setting).where(eq(setting.key, OFFSITE_KEY));
    await writeAudit({ actor: who.actor, action: "backup.offsite.remove", permission: BACKUPS_PERMISSION, targetType: "setting", targetId: OFFSITE_KEY, before: shown(before), ip: who.ip }, tx);
    return { ok: true as const, message: "Off-site copies are off. The copies already there stay, and still need the passphrase you kept." };
  });
}

const storageOf = (s: Stored): Storage => ({ endpoint: s.endpoint, region: s.region, bucket: s.bucket, accessKeyId: s.accessKeyId, secret: secretBox().open(s.secret, SECRET_AAD) });
const keyIn = (s: Stored, name: string) => (s.folder ? `${s.folder}/${name}` : name);
const statusWords = (status: number) => status === 0 ? "The storage couldn't be reached."
  : status === 403 || status === 401 ? "The storage refused the key. Check the access key ID, the secret and that the key may write to this bucket."
  : status === 404 ? "The storage has no bucket of that name at this address."
  : `The storage answered with an error (${status}).`;

/** Writes one small file to the storage, records whether it worked, and audits the test. */
export async function testOffsite(who: Who): Promise<Done> {
  const s = await readStored();
  if (!s) return { ok: false, errors: ["Off-site copies aren't set up."] };
  let status = 0;
  try {
    const body = Buffer.from(`A test from the club's Boosters Rocket portal, at ${new Date().toISOString()}. It can be deleted.\n`);
    status = await putObject(storageOf(s), keyIn(s, TEST_KEY), body, body.length, { timeoutMs: 20_000 });
  } catch { status = 0; }
  const ok = status >= 200 && status < 300;
  await db.transaction(async (tx) => {
    const now = await readStored(tx, true);
    if (now) await tx.update(setting).set({ value: { ...now, lastTest: { at: new Date().toISOString(), ok } }, updatedAt: new Date() }).where(eq(setting.key, OFFSITE_KEY));
    await writeAudit({ actor: who.actor, action: "backup.offsite.test", permission: BACKUPS_PERMISSION, targetType: "setting", targetId: OFFSITE_KEY, after: { ok, status }, ip: who.ip }, tx);
  });
  return ok ? { ok: true, message: "It works: a small test file was written to the storage." } : { ok: false, errors: [statusWords(status)] };
}

/**
 * OpenSSL's `enc -aes-256-cbc -pbkdf2 -md sha256` format, as a stream: "Salted__", eight bytes of salt, then the body
 * in AES-256-CBC with PKCS#7 padding, its key and IV from PBKDF2-HMAC-SHA256 of the passphrase. `length` is the size of
 * what comes out for a body of `n` bytes.
 */
export function opensslEncrypt(passphrase: string): Transform {
  const salt = randomBytes(8);
  const kiv = pbkdf2Sync(passphrase, salt, PBKDF2_ITER, 48, "sha256");
  const cipher = createCipheriv("aes-256-cbc", kiv.subarray(0, 32), kiv.subarray(32, 48));
  let head = false;
  return new Transform({
    transform(chunk: Buffer, _e, cb: TransformCallback) {
      if (!head) { this.push(Buffer.concat([Buffer.from("Salted__", "latin1"), salt])); head = true; }
      cb(null, cipher.update(chunk));
    },
    flush(cb: TransformCallback) {
      if (!head) this.push(Buffer.concat([Buffer.from("Salted__", "latin1"), salt]));
      cb(null, cipher.final());
    },
  });
}
export const encryptedLength = (n: number) => 16 + (Math.floor(n / 16) + 1) * 16;

/**
 * The worker's share (src/lib/jobs/runner.ts): each backup the agent staged for its off-site copy (a finished `upload`
 * request whose file is in the outbox), encrypted and put in the storage as boosters-rocket-<time>.tar.enc, its outcome
 * recorded on the request and on the backup's row, and the staged file removed. One a wake; nothing while copies are off.
 */
export async function sendOffsiteCopies(o: { outbox?: string } = {}): Promise<{ sent: number; failed: number }> {
  const s = await readStored();
  if (!s) return { sent: 0, failed: 0 };
  const outbox = o.outbox ?? env.BACKUP_OUTBOX;
  const [r] = await db.select().from(backupRequest)
    .where(and(eq(backupRequest.kind, "upload"), eq(backupRequest.outcome, "ok"), sql`not (${backupRequest.result} ? 'sent')`))
    .orderBy(backupRequest.finishedAt).limit(1);
  if (!r) return { sent: 0, failed: 0 };
  const stamp = r.backupAt;
  const name = (r.result as { file?: unknown } | null)?.file;
  const file = typeof name === "string" && stamp && STAMP.test(stamp) && name === `upload-${stamp}.tar` ? path.join(outbox, name) : null;
  const size = file ? await stat(file).then((x) => x.size, () => null) : null;
  let ok = false;
  if (file && size !== null) {
    try {
      const status = await putObject(storageOf(s), keyIn(s, `boosters-rocket-${stamp}.tar.enc`),
        createReadStream(file).pipe(opensslEncrypt(secretBox().open(s.passphrase, PASS_AAD))), encryptedLength(size));
      ok = status >= 200 && status < 300;
    } catch { ok = false; }
  }
  await recordOffsite(r.id, stamp, ok);
  if (file) await unlink(file).catch(() => {});
  return ok ? { sent: 1, failed: 0 } : { sent: 0, failed: 1 };
}

/** The outcome of one off-site copy, on its request and its backup's row: the worker's mark, not a person's act. */
async function recordOffsite(id: string, stamp: string | null, ok: boolean): Promise<void> {
  await db.update(backupRequest).set({ result: sql`coalesce(${backupRequest.result}, '{}'::jsonb) || ${JSON.stringify({ sent: true, ok })}::jsonb` }).where(eq(backupRequest.id, id));
  if (stamp) await db.update(backupFile).set({ offsiteAt: new Date(), offsiteOutcome: ok ? "ok" : "failed" }).where(eq(backupFile.backupAt, stamp));
}
