import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { loadProviders } from "@/lib/auth/providers";
import { normalizeEmail } from "@/lib/setup/state";
import { mailConfigHash } from "./config-hash";
import { SMTP_PASSWORD_AAD } from "./senders";
import type { SmtpSecurity, StoredMailConfig } from "./types";

export const MAIL_KEY = "mail";
export const MAIL_STATUS_KEY = "mail.status";

export type MailStatus = { verifiedHash: string | null; verifiedAt: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null };
const EMPTY_STATUS: MailStatus = { verifiedHash: null, verifiedAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null };
export type MailDraft =
  | { method: "graph"; mailbox: string }
  | { method: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; from: string; password: string | null };
export type MailConfigView =
  | { method: "graph"; mailbox: string }
  | { method: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; from: string };
export type MailSummary = { config: MailConfigView | null; passwordSaved: boolean; passwordReadable: boolean; working: boolean; status: MailStatus; graphAvailable: boolean };
export type MailAttention = { kind: "not_set_up" | "not_tested" | "failing"; lastError: string | null; since: string | null };
type StoredSmtp = Extract<StoredMailConfig, { method: "smtp" }>;

const storedSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("graph"), mailbox: z.string() }),
  z.object({ method: z.literal("smtp"), host: z.string(), port: z.number(), security: z.enum(["starttls", "tls"]), username: z.string(),
    from: z.string(), passwordCiphertext: z.string(), passwordKeyId: z.string() }),
]);

export async function getStoredMailConfig(tx?: Tx): Promise<StoredMailConfig | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, MAIL_KEY));
  const parsed = storedSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

export async function getMailStatus(tx?: Tx): Promise<MailStatus> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, MAIL_STATUS_KEY));
  return { ...EMPTY_STATUS, ...((row?.value as Partial<MailStatus> | undefined) ?? {}) };
}

/** Merges into the stored status in one statement, so two sends finishing together don't lose each other's fields. */
export async function patchMailStatus(patch: Partial<MailStatus>, tx?: Tx): Promise<void> {
  await (tx ?? db).insert(setting).values({ key: MAIL_STATUS_KEY, value: { ...EMPTY_STATUS, ...patch } })
    .onConflictDoUpdate({ target: setting.key, set: { value: sql`${setting.value} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() } });
}

export async function mailWorking(): Promise<boolean> {
  const [c, s] = await Promise.all([getStoredMailConfig(), getMailStatus()]);
  return c !== null && s.verifiedHash === mailConfigHash(c);
}

const view = (c: StoredMailConfig): MailConfigView => (c.method === "graph" ? { method: "graph", mailbox: c.mailbox }
  : { method: "smtp", host: c.host, port: c.port, security: c.security, username: c.username, from: c.from });
function passwordReadable(c: StoredMailConfig): boolean {
  if (c.method !== "smtp") return false;
  try { secretBox().open({ ciphertext: c.passwordCiphertext, keyId: c.passwordKeyId }, SMTP_PASSWORD_AAD); return true; }
  catch (e) { if (e instanceof SecretBoxError) return false; throw e; }
}

/** What the setup and Settings pages may show: never the password or its ciphertext. */
export async function mailSummary(): Promise<MailSummary> {
  const [c, status, providers] = await Promise.all([getStoredMailConfig(), getMailStatus(), loadProviders()]);
  return {
    config: c ? view(c) : null, passwordSaved: c?.method === "smtp", passwordReadable: c ? passwordReadable(c) : false,
    working: c !== null && status.verifiedHash === mailConfigHash(c), status, graphAvailable: providers.staffMicrosoft !== null,
  };
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function parseMailForm(f: Record<string, string>): { ok: true; draft: MailDraft } | { ok: false; errors: string[] } {
  const method = (f.method ?? "").trim();
  if (method === "graph") {
    const mailbox = normalizeEmail(f.mailbox ?? "");
    return mailbox ? { ok: true, draft: { method, mailbox } } : { ok: false, errors: ["Enter the mailbox to send from, like webmaster@yourclub.org."] };
  }
  if (method !== "smtp") return { ok: false, errors: ["Choose how to send mail."] };
  const errors: string[] = [];
  const host = (f.host ?? "").trim().toLowerCase();
  if (!HOST.test(host)) errors.push("Host is a server name like smtp.example.org, without https:// or a path.");
  const port = Number((f.port ?? "").trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("Port must be a number from 1 to 65535.");
  const security = (f.security ?? "").trim();
  if (security !== "starttls" && security !== "tls") errors.push("Choose STARTTLS or TLS. Booster Rocket doesn't send mail unencrypted.");
  const username = (f.username ?? "").trim();
  if (!username) errors.push("Enter the SMTP username.");
  const from = normalizeEmail(f.from ?? "");
  if (!from) errors.push("Enter the From address, like boosters@yourclub.org.");
  const password = f.password ?? "";
  if (password.length > 1024) errors.push("That password is too long.");
  if (errors.length || !from) return { ok: false, errors };
  return { ok: true, draft: { method, host, port, security: security as SmtpSecurity, username, from, password: password === "" ? null : password } };
}

const LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('booster.mail_settings'))`;

export async function saveMailSettings(draft: MailDraft, o: { actor: Actor; ip: string | null; permission?: string }): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  if (draft.method === "graph" && !(await loadProviders()).staffMicrosoft) {
    return { ok: false, errors: ["Sending through Microsoft 365 uses the staff sign-in app. Set up staff sign-in with Microsoft first, or use SMTP."] };
  }
  return db.transaction(async (tx): Promise<{ ok: true } | { ok: false; errors: string[] }> => {
    await tx.execute(LOCK);
    const existing = await getStoredMailConfig(tx);
    let next: StoredMailConfig;
    if (draft.method === "graph") next = { method: "graph", mailbox: draft.mailbox };
    else {
      const { password, ...rest } = draft;
      if (password === null && existing?.method !== "smtp") return { ok: false, errors: ["Enter the SMTP password."] };
      const sealed = password !== null ? secretBox().seal(password, SMTP_PASSWORD_AAD)
        : { ciphertext: (existing as StoredSmtp).passwordCiphertext, keyId: (existing as StoredSmtp).passwordKeyId };
      next = { ...rest, passwordCiphertext: sealed.ciphertext, passwordKeyId: sealed.keyId };
    }
    await tx.insert(setting).values({ key: MAIL_KEY, value: next }).onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: new Date() } });
    await writeAudit({ actor: o.actor, action: "settings.mail.save", permission: o.permission, targetType: "setting", targetId: MAIL_KEY,
      before: existing ? view(existing) : null,
      after: { ...view(next), ...(draft.method === "smtp" ? { passwordChanged: draft.password !== null } : {}) }, ip: o.ip }, tx);
    return { ok: true };
  });
}

/** For the staff warning: not set up, not tested with these settings, or the last send failed. */
export async function mailAttention(): Promise<MailAttention | null> {
  const [c, s] = await Promise.all([getStoredMailConfig(), getMailStatus()]);
  if (!c) return { kind: "not_set_up", lastError: null, since: null };
  if (s.verifiedHash !== mailConfigHash(c)) return { kind: "not_tested", lastError: null, since: null };
  if (s.lastFailureAt && (!s.lastSuccessAt || s.lastFailureAt > s.lastSuccessAt)) return { kind: "failing", lastError: s.lastError, since: s.lastFailureAt };
  return null;
}

const MAIL_FIELDS = ["method", "mailbox", "host", "port", "security", "username", "from", "password"] as const;
/** The mail form's fields as strings, for parseMailForm. */
export const mailFormFields = (form: FormData): Record<string, string> =>
  Object.fromEntries(MAIL_FIELDS.map((n) => [n, String(form.get(n) ?? "")]));
