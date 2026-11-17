// The electronic-records consent a guardian gives before a form is made for them to sign (v1 spec §9.2 step 2).
// Without a row for the signed-in guardian and this version of the text, no document is made and no signing token is
// handed out. The record (who, when, from which address, which version) is kept with the request as evidence (§9.4).
import "server-only";
import { and, eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { signatureConsent } from "@/lib/db/schema";

/**
 * The version of the text below. Change it whenever a word of the text changes: a guardian who agreed to an earlier
 * version is asked again, and each record names the version that was on the screen.
 */
export const CONSENT_VERSION = "2026-11-16";

/** The heading and paragraphs a guardian reads. Plain text only. Clubs should have a lawyer read their forms; this is no legal advice. */
export const CONSENT_TEXT = {
  heading: "Before you sign",
  paragraphs: [
    "You are about to sign this form on your screen. A signature you make here counts the same as one made with a pen on paper.",
    "The signed form is kept as an electronic record by the club, and you can ask the club for a copy at any time.",
    "You don't have to sign this way. If you would rather sign on paper, don't go on: ask the club for a paper copy.",
    "To read and sign the form you need a phone or computer with a web browser and a connection to the internet, which you are using now.",
  ],
  agree: "I agree to sign electronically",
} as const;

export async function hasConsent(requestId: string, parentId: string, tx?: Tx): Promise<boolean> {
  const rows = await (tx ?? db).select({ id: signatureConsent.id }).from(signatureConsent)
    .where(and(eq(signatureConsent.requestId, requestId), eq(signatureConsent.parentId, parentId), eq(signatureConsent.textVersion, CONSENT_VERSION))).limit(1);
  return rows.length > 0;
}

/** Records the agreement once; a second press changes nothing. True when this call made the record. */
export async function recordConsent(tx: Tx, o: { requestId: string; parentId: string; name: string; email: string; ip: string | null; userAgent: string | null }): Promise<boolean> {
  const made = await tx.insert(signatureConsent).values({ requestId: o.requestId, parentId: o.parentId, parentName: o.name, parentEmail: o.email,
    textVersion: CONSENT_VERSION, ip: o.ip, userAgent: o.userAgent?.slice(0, 300) ?? null }).onConflictDoNothing().returning({ id: signatureConsent.id });
  return made.length > 0;
}
