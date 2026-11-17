// The portal's connection to the club's own Documenso (v1 spec §9; verification report): its address, the API token
// and the secret Documenso sends with each webhook. Both secrets are sealed like the others (the mail password, the
// QuickBooks keys); neither is ever sent to a page after it is saved. Imports no staff-only module: parent pages read
// through here whether forms are set up (tests/integration/page-guards.test.ts scans this folder).
import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/env";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { DOCUMENSO_ERRORS, documensoCode, documensoHealth, listTemplates, type DocumensoConfig, type DocumensoErrorCode } from "@/lib/documenso/client";

export const FORMS_KEY = "forms";
export const FORMS_STATUS_KEY = "forms.status";
export const FORMS_AAD = { token: "forms:api-token", webhookSecret: "forms:webhook-secret" } as const;

const storedSchema = z.object({
  origin: z.string(), tokenCiphertext: z.string(), tokenKeyId: z.string(),
  webhookSecretCiphertext: z.string().nullable().optional().default(null), webhookSecretKeyId: z.string().nullable().optional().default(null),
});
type Stored = z.infer<typeof storedSchema>;

/** When each part last worked, for the Health page. Times are ISO strings; `lastApiError` is a short code, never a body. */
export type FormsStatus = {
  lastApiOkAt: string | null; lastApiFailureAt: string | null; lastApiError: DocumensoErrorCode | "unexpected" | null;
  lastWebhookAt: string | null; lastAskedAt: string | null;
};
const EMPTY_STATUS: FormsStatus = { lastApiOkAt: null, lastApiFailureAt: null, lastApiError: null, lastWebhookAt: null, lastAskedAt: null };

export type FormsOp = { actor: Actor; ip: string | null; permission?: string };
type Done<T = object> = ({ ok: true } & T) | { ok: false; errors: string[] };

async function stored(tx?: Tx): Promise<Stored | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, FORMS_KEY));
  const parsed = storedSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}
function opened(ciphertext: string | null, keyId: string | null, aad: string): string | null {
  if (!ciphertext || !keyId) return null;
  try { return secretBox().open({ ciphertext, keyId }, aad); } catch (e) { if (e instanceof SecretBoxError) return null; throw e; }
}

/** The address of Documenso and the token to call it with; null until forms are set up (or when the token can't be opened with this server's key). */
export async function getFormsConfig(): Promise<DocumensoConfig | null> {
  const s = await stored();
  const token = s ? opened(s.tokenCiphertext, s.tokenKeyId, FORMS_AAD.token) : null;
  return s && token ? { origin: s.origin, token } : null;
}

/** Where Documenso sends its webhooks: an address of this portal, built on the address its installer gave it. */
export const webhookAddress = (): string => `${env.APP_URL.replace(/\/+$/, "")}/api/documenso/webhook`;

export async function getFormsStatus(): Promise<FormsStatus> {
  const [row] = await db.select().from(setting).where(eq(setting.key, FORMS_STATUS_KEY));
  return { ...EMPTY_STATUS, ...((row?.value as Partial<FormsStatus> | undefined) ?? {}) };
}
/** Merges into the stored status in one statement, so two calls finishing together don't lose each other's fields. */
async function patchStatus(patch: Partial<FormsStatus>): Promise<void> {
  await db.insert(setting).values({ key: FORMS_STATUS_KEY, value: { ...EMPTY_STATUS, ...patch } })
    .onConflictDoUpdate({ target: setting.key, set: { value: sql`${setting.value} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() } });
}
export const noteApiOk = () => patchStatus({ lastApiOkAt: new Date().toISOString() });
export const noteApiFailure = (code: FormsStatus["lastApiError"]) => patchStatus({ lastApiFailureAt: new Date().toISOString(), lastApiError: code });
export const noteWebhook = () => patchStatus({ lastWebhookAt: new Date().toISOString() });
export const noteAsked = () => patchStatus({ lastAskedAt: new Date().toISOString() });

/** What the settings page and the Health page may show: never the token, the secret or their ciphertexts. */
export type FormsSummary = { origin: string | null; tokenSaved: boolean; tokenReadable: boolean; webhookSecretSaved: boolean; webhookAddress: string; status: FormsStatus };
export async function formsSummary(): Promise<FormsSummary> {
  const [s, status] = await Promise.all([stored(), getFormsStatus()]);
  return {
    origin: s?.origin ?? null, tokenSaved: s !== null, tokenReadable: s !== null && opened(s.tokenCiphertext, s.tokenKeyId, FORMS_AAD.token) !== null,
    webhookSecretSaved: Boolean(s?.webhookSecretCiphertext), webhookAddress: webhookAddress(), status,
  };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * The one origin Documenso is configured with (its NEXT_PUBLIC_WEBAPP_URL), and nothing more: signing is refused by
 * Documenso under any other name, scheme or port, with no message (verification, 1a). https, or http only on this
 * machine itself, where a trial Documenso runs: the signing token travels in the frame's address.
 */
export function parseOrigin(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > 300) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null;
  return url.origin;
}

export type FormsDraft = { origin: string; token: string | null };
export function parseFormsForm(f: { origin: string; token: string }): { ok: true; draft: FormsDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const origin = parseOrigin(f.origin);
  if (!origin) errors.push("Enter Documenso's address as people open it, like https://sign.yourclub.org: https, the name, and nothing after it.");
  const token = f.token.trim();
  if (token.length > 500 || (token !== "" && !/^[\x21-\x7e]+$/.test(token))) errors.push("That API token doesn't look right. Copy it again from Documenso: it starts with api_.");
  return errors.length || !origin ? { ok: false, errors } : { ok: true, draft: { origin, token: token || null } };
}

const LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('booster.forms_settings'))`;

/** Saves the address and the API token. A blank token keeps the saved one, and only for the address it was saved with. */
export async function saveFormsSettings(draft: FormsDraft, o: FormsOp): Promise<Done> {
  return db.transaction(async (tx): Promise<Done> => {
    await tx.execute(LOCK);
    const existing = await stored(tx);
    if (draft.token === null && !existing) return { ok: false, errors: ["Enter the API token from Documenso."] };
    // A blank field keeps the saved token only for the place it already goes: otherwise someone who doesn't know it
    // could point the address at a server of their own and be sent it.
    if (draft.token === null && existing!.origin !== draft.origin) return { ok: false, errors: ["Enter the API token again. The address changed, and the saved token is only kept for the address it was saved with."] };
    const sealed = draft.token !== null ? secretBox().seal(draft.token, FORMS_AAD.token) : { ciphertext: existing!.tokenCiphertext, keyId: existing!.tokenKeyId };
    const next: Stored = { origin: draft.origin, tokenCiphertext: sealed.ciphertext, tokenKeyId: sealed.keyId,
      webhookSecretCiphertext: existing?.webhookSecretCiphertext ?? null, webhookSecretKeyId: existing?.webhookSecretKeyId ?? null };
    await tx.insert(setting).values({ key: FORMS_KEY, value: next }).onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: new Date() } });
    await writeAudit({ actor: o.actor, action: "settings.forms.save", permission: o.permission, targetType: "setting", targetId: FORMS_KEY, ip: o.ip,
      before: existing ? { origin: existing.origin } : null, after: { origin: next.origin, tokenChanged: draft.token !== null } }, tx);
    return { ok: true };
  });
}

/**
 * Makes a new webhook secret and returns it, once, for the Admin to paste into Documenso. The one before stops
 * working at once. Only its seal is kept: the page can't show it again, so losing it means making another.
 */
export async function newWebhookSecret(o: FormsOp): Promise<Done<{ secret: string }>> {
  return db.transaction(async (tx): Promise<Done<{ secret: string }>> => {
    await tx.execute(LOCK);
    const existing = await stored(tx);
    if (!existing) return { ok: false, errors: ["Save Documenso's address and API token first."] };
    const secret = randomBytes(32).toString("base64url");
    const sealed = secretBox().seal(secret, FORMS_AAD.webhookSecret);
    const next: Stored = { ...existing, webhookSecretCiphertext: sealed.ciphertext, webhookSecretKeyId: sealed.keyId };
    await tx.insert(setting).values({ key: FORMS_KEY, value: next }).onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: new Date() } });
    await writeAudit({ actor: o.actor, action: "settings.forms.webhook_secret", permission: o.permission, targetType: "setting", targetId: FORMS_KEY, ip: o.ip,
      before: { hadSecret: Boolean(existing.webhookSecretCiphertext) }, after: { hasSecret: true } }, tx);
    return { ok: true, secret };
  });
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
/**
 * Whether a webhook carries the secret (header X-Documenso-Secret: a plain shared secret, no signature). Compared in
 * constant time, over digests so the lengths never differ. False while no secret is set: nothing is accepted then.
 */
export async function isWebhookSecret(sent: string | null): Promise<boolean> {
  const s = await stored();
  const secret = s ? opened(s.webhookSecretCiphertext, s.webhookSecretKeyId, FORMS_AAD.webhookSecret) : null;
  // Compared even when there is nothing to compare with, so the answer takes as long either way.
  const right = timingSafeEqual(digest(sent ?? ""), digest(secret ?? ""));
  return right && secret !== null && sent !== null && sent.length > 0;
}

/**
 * "Check the connection": Documenso's own health answer (its database and signing certificate), then one call with
 * the token. Says in words which of the two failed. Nothing of either answer is shown but a count of templates.
 */
export async function checkFormsConnection(): Promise<{ ok: true; message: string } | { ok: false; errors: string[] }> {
  const config = await getFormsConfig();
  if (!config) return { ok: false, errors: ["Save Documenso's address and API token first."] };
  try {
    await documensoHealth(config.origin);
  } catch (e) {
    const code = documensoCode(e);
    await noteApiFailure(code);
    return { ok: false, errors: [code === "server"
      ? "Documenso answered, and says it isn't healthy: its database or its signing certificate needs attention. Check Documenso on its server."
      : `${code === "unexpected" ? "Documenso couldn't be checked." : DOCUMENSO_ERRORS[code]} Check the address: it must be the one Documenso itself is set up with, exactly.`] };
  }
  try {
    const templates = await listTemplates(config);
    await noteApiOk();
    return { ok: true, message: `Connected. Documenso is healthy and accepted the API token. It has ${templates.length === 1 ? "1 template" : `${templates.length} templates`}${templates.length >= 100 ? " or more" : ""}.` };
  } catch (e) {
    const code = documensoCode(e);
    await noteApiFailure(code);
    return { ok: false, errors: [code === "unauthorized" ? "Documenso is healthy, but it refused the API token. Make a new token in Documenso (Team settings, API Tokens) and save it here."
      : `Documenso is healthy, but the call with the API token failed. ${code === "unexpected" ? "" : DOCUMENSO_ERRORS[code]}`.trim()] };
  }
}
