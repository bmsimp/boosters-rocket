import { db } from "@/lib/db/client";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getClubSettings } from "@/lib/settings/club";
import { normalizeEmail } from "@/lib/setup/state";
import { buildSender } from "./senders";
import { getStoredMailConfig, patchMailStatus, MAIL_KEY } from "./settings";
import { mailConfigHash } from "./config-hash";
import { testMessage, type Brand } from "./messages";
import { MailSendError, type MailMessage, type MailPurpose, type StoredMailConfig } from "./types";

/** `recipientRefused`: the server refused this one address on its own account (MailSendError), not a failure of the mail itself. */
export type SendOutcome = { ok: true } | { ok: false; error: string; recipientRefused?: true };
const MAIL_ACTOR: Actor = { door: "system", id: null, label: "mail" };

export async function currentBrand(): Promise<Brand> {
  const c = await getClubSettings();
  return { clubName: c.name, color: c.color };
}

async function deliver(stored: StoredMailConfig, m: MailMessage, o: { purpose: MailPurpose; actor?: Actor; ip?: string | null }): Promise<SendOutcome> {
  try {
    await (await buildSender(stored, await currentBrand()))(m);
  } catch (e) {
    // Only MailSendError's sentence is kept; any other error could carry anything, so it becomes a fixed sentence.
    const error = e instanceof MailSendError ? e.message : "Sending failed for an unexpected reason.";
    await patchMailStatus({ lastFailureAt: new Date().toISOString(), lastError: error, lastFailed: true });
    await writeAudit({ actor: o.actor ?? MAIL_ACTOR, action: "mail.failed", targetType: "setting", targetId: MAIL_KEY,
      after: { purpose: o.purpose, method: stored.method, to: m.to, error }, ip: o.ip ?? null });
    return { ok: false, error, ...(e instanceof MailSendError && e.recipientRefused ? { recipientRefused: true as const } : {}) };
  }
  await patchMailStatus({ lastSuccessAt: new Date().toISOString(), lastFailed: false });
  return { ok: true };
}

/** Sends one message with the saved settings. Never throws for a send failure; the failure is audited without the body. */
export async function sendMail(m: MailMessage, o: { purpose: MailPurpose; actor?: Actor; ip?: string | null }): Promise<SendOutcome> {
  const stored = await getStoredMailConfig();
  if (!stored) return { ok: false, error: "Outgoing mail isn't set up." };
  return deliver(stored, m, o);
}

/** **Send test email**. A success marks exactly the settings it was sent with as working. */
export async function sendTestMail(rawTo: string, o: { actor: Actor; ip: string | null; permission?: string }): Promise<SendOutcome> {
  const to = normalizeEmail(rawTo);
  if (!to) return { ok: false, error: "Enter the address to send the test to." };
  const stored = await getStoredMailConfig();
  if (!stored) return { ok: false, error: "Save the mail settings first." };
  const r = await deliver(stored, testMessage(await currentBrand(), to), { purpose: "test", actor: o.actor, ip: o.ip });
  await db.transaction(async (tx) => {
    // If the settings changed while the test was out, the new ones stay untested.
    const now = await getStoredMailConfig(tx);
    if (r.ok && now && mailConfigHash(now) === mailConfigHash(stored)) {
      await patchMailStatus({ verifiedHash: mailConfigHash(stored), verifiedAt: new Date().toISOString() }, tx);
    }
    await writeAudit({ actor: o.actor, action: "settings.mail.test", permission: o.permission, targetType: "setting", targetId: MAIL_KEY,
      after: { to, ok: r.ok, ...(r.ok ? {} : { error: r.error }) }, ip: o.ip }, tx);
  });
  return r;
}
