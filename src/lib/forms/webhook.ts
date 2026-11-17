// Hearing from Documenso (v1 spec §9.2 step 5; verification, section 4.g): a webhook carries a plain shared secret, no
// signature, no event id, and is not retried. So a message is only ever a hint that one request may have moved: the
// portal reads that request's document from Documenso's API and stores what the API says. A forged body, a repeated
// one, one that arrives out of order or one that lies about a status can change nothing the API doesn't confirm.
// Nothing of the body is logged or stored: it holds every recipient's signing token.
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { signatureRequest } from "@/lib/db/schema";
import { isUuid } from "@/lib/seasons/ids";
import { DOCUMENSO_ACTOR, readAndStore } from "./requests";
import { getFormsConfig, isWebhookSecret, noteWebhook } from "./settings";

/** Far more than a document with two recipients takes; anything longer is not one of Documenso's messages. */
export const WEBHOOK_BODY_MAX = 256 * 1024;

export type WebhookOutcome = "refused" | "ignored" | "read" | "not_read";

/**
 * `secret` is the X-Documenso-Secret header and `body` the message as text. "refused": the secret is wrong, or none
 * is set. Otherwise the arrival is noted for the Health page, and the one thing read from the body is which request
 * it is about (the externalId the portal gave the document): "ignored" when it names none the portal has, "read"
 * when that request's own document was read from the API, "not_read" when Documenso couldn't be asked just now (the
 * worker's job asks again).
 */
export async function hearWebhook(secret: string | null, body: string): Promise<WebhookOutcome> {
  if (!(await isWebhookSecret(secret))) return "refused";
  await noteWebhook();
  let externalId: unknown;
  try { externalId = (JSON.parse(body) as { payload?: { externalId?: unknown } } | null)?.payload?.externalId; } catch { return "ignored"; }
  if (!isUuid(externalId)) return "ignored";
  const [row] = await db.select().from(signatureRequest).where(eq(signatureRequest.id, externalId));
  // The document read is the one the portal itself recorded for the request, never one the message names.
  if (!row || row.envelopeId === null) return "ignored";
  // A request that is finished stays as it is whatever is read later, so Documenso isn't asked.
  if (row.state === "complete" || row.state === "declined") return "ignored";
  const config = await getFormsConfig();
  if (!config) return "not_read";
  const read = await readAndStore(row, config, { actor: DOCUMENSO_ACTOR, ip: null });
  return read.ok ? "read" : "not_read";
}
