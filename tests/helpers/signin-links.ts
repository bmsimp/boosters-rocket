import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/lib/db/client";
import { parentAuthAccount, parentDevice, parentSigninToken, signinCode } from "@/lib/db/schema";
import { hashSigninCode } from "@/lib/parents/signin-codes";
import { hashDeviceToken } from "@/lib/parents/devices";
import { holdSigninLink, mintSigninLink, type LinkPurpose } from "@/lib/parents/signin-links";

/** Who makes a link in a test: the system, as the staff reset will (SI-9). */
const SYSTEM = { door: "system" as const, id: null, label: "test" };

/** A person's set-up or reset link, made as the portal makes one (mintSigninLink()); its token, which only the caller ever holds. */
export async function mintLink(parentId: string, purpose: LinkPurpose, now = new Date()): Promise<string> {
  return db.transaction((tx) => mintSigninLink(tx, { parentId, purpose, actor: SYSTEM, ip: null, now }));
}

/**
 * A person's link held while its mail is on its way, as the request page holds one (holdSigninLink()): stored, working
 * for nobody yet. Its token.
 */
export async function holdLink(parentId: string, purpose: LinkPurpose, now = new Date()): Promise<string> {
  return (await db.transaction((tx) => holdSigninLink(tx, { parentId, purpose, now }))).token;
}

/** A token of a token's shape that names no link. */
export const unknownToken = () => randomBytes(32).toString("base64url");

/** A password for a person, kept as Better Auth's sign-up keeps one: the `credential` row of `parent_auth_account`. */
export async function seedPassword(authUserId: string, password: string): Promise<void> {
  await db.insert(parentAuthAccount).values({ id: randomUUID(), accountId: authUserId, providerId: "credential", userId: authUserId, password: await hashPassword(password) });
}

/** The person's `credential` rows (a person never has more than one). */
export const credentialRows = (authUserId: string) => db.select().from(parentAuthAccount).where(eq(parentAuthAccount.userId, authUserId));

/**
 * A device remembered for the person, as a sign-in remembers one (recordStrongSignin(), src/lib/parents/devices.ts):
 * only the keyed hash of its token is stored. Its token, for the device cookie a test sends, and its row's id; with
 * `expiresAt`, one that ends then (in the past for an expired one).
 */
export async function seedDevice(parentId: string, o: { expiresAt?: Date } = {}): Promise<{ token: string; id: string }> {
  const token = randomBytes(32).toString("base64url");
  const [row] = await db.insert(parentDevice).values({ parentId, tokenHash: hashDeviceToken(token), expiresAt: o.expiresAt ?? new Date(Date.now() + 90 * 86_400_000) })
    .returning({ id: parentDevice.id });
  return { token, id: row!.id };
}

/** The person's remembered device rows. */
export const deviceRows = (parentId: string) => db.select().from(parentDevice).where(eq(parentDevice.parentId, parentId));

/**
 * A sign-in code for the person, as a code request stores one: unused, or spent at `usedAt`; with `code`, one that
 * verifySigninCode() takes for those six digits. Its row's id.
 */
export async function seedCode(parentId: string, o: { code?: string; usedAt?: Date } = {}): Promise<string> {
  const codeHash = o.code ? hashSigninCode(parentId, o.code) : createHash("sha256").update(randomUUID()).digest("hex");
  const at = o.usedAt ?? new Date();
  const [row] = await db.insert(signinCode).values({ parentId, codeHash, createdAt: new Date(at.getTime() - 1000), expiresAt: new Date(at.getTime() + 600_000), usedAt: o.usedAt ?? null })
    .returning({ id: signinCode.id });
  return row!.id;
}

/**
 * A message as the SMTP sink kept it (`sink.messages[i].raw`), with its quoted-printable soft line breaks joined and
 * its `=XX` escapes decoded, so a sentence or a link the mailer folded over two lines reads whole again. Every message
 * the portal sends is plain ASCII, which the mailer writes as quoted-printable (or as it is).
 */
export const mailText = (raw: string): string =>
  raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/**
 * One part of a sink message (`sink.messages[i].raw`), its text or its HTML, decoded as the mailer encoded it
 * (quoted-printable, base64 or as it is), with its own line breaks kept as they are in the message.
 */
export function mailPart(raw: string, kind: "plain" | "html"): string {
  const at = raw.indexOf(`Content-Type: text/${kind}`);
  if (at < 0) throw new Error(`the message has no text/${kind} part`);
  const part = raw.slice(at);
  const head = part.slice(0, part.indexOf("\r\n\r\n"));
  const end = part.indexOf("\r\n--", head.length);
  const body = part.slice(head.length + 4, end < 0 ? undefined : end);
  if (/Content-Transfer-Encoding: base64/i.test(head)) return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  return /Content-Transfer-Encoding: quoted-printable/i.test(head) ? mailText(body) : body;
}

/** The set-up tokens a sink message carries (its text and HTML parts both hold the link): each once. */
export const setupTokensIn = (raw: string): string[] =>
  [...new Set([...mailText(raw).matchAll(/\/sign-in\/set-up\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g)].map((m) => m[1]!))];

/** The person's link rows, used or not. */
export const linkRows = (parentId: string) => db.select().from(parentSigninToken).where(eq(parentSigninToken.parentId, parentId));
