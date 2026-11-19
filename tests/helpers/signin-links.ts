import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/lib/db/client";
import { parentAuthAccount, parentDevice, parentSigninToken, signinCode } from "@/lib/db/schema";
import { hashSigninCode } from "@/lib/parents/signin-codes";
import { mintSigninLink, type LinkPurpose } from "@/lib/parents/signin-links";

/** Who makes a link in a test: the system, as the welcome job will (SI-4). */
const SYSTEM = { door: "system" as const, id: null, label: "test" };

/** A person's set-up or reset link, made as the portal makes one (mintSigninLink()); its token, which only the caller ever holds. */
export async function mintLink(parentId: string, purpose: LinkPurpose, now = new Date()): Promise<string> {
  return db.transaction((tx) => mintSigninLink(tx, { parentId, purpose, actor: SYSTEM, ip: null, now }));
}

/** A token of a token's shape that names no link. */
export const unknownToken = () => randomBytes(32).toString("base64url");

/** A password for a person, kept as Better Auth's sign-up keeps one: the `credential` row of `parent_auth_account`. */
export async function seedPassword(authUserId: string, password: string): Promise<void> {
  await db.insert(parentAuthAccount).values({ id: randomUUID(), accountId: authUserId, providerId: "credential", userId: authUserId, password: await hashPassword(password) });
}

/** The person's `credential` rows (a person never has more than one). */
export const credentialRows = (authUserId: string) => db.select().from(parentAuthAccount).where(eq(parentAuthAccount.userId, authUserId));

/** A device remembered for the person, as a later slice (SI-3b) will make one: only a hash of its token is stored. */
export async function seedDevice(parentId: string): Promise<void> {
  await db.insert(parentDevice).values({ parentId, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), expiresAt: new Date(Date.now() + 90 * 86_400_000) });
}

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

/** The person's link rows, used or not. */
export const linkRows = (parentId: string) => db.select().from(parentSigninToken).where(eq(parentSigninToken.parentId, parentId));
