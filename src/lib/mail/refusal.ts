// Whether an SMTP send failed on the one recipient's own account or because the mail itself is failing: one pure rule,
// read from what the sender reports (nodemailer's error: its code, the command it failed at, the reply's code and text).
// The worker's welcomes go by it (MailSendError.recipientRefused, sendOwedWelcomes() in src/lib/parents/welcome.ts): a
// recipient's own refusal leaves the rest of the batch to go, and the mail failing ends it.

/** What nodemailer's error carries, any of it possibly missing: it is read, never trusted to have a shape. */
export type SmtpFailure = { code?: unknown; command?: unknown; responseCode?: unknown; response?: unknown };

/**
 * The enhanced status code (RFC 3463) at the start of a reply's text, after its three-digit code: "550 5.7.1 Relaying
 * denied" gives { class: 5, subject: 7, detail: 1 }. Null when the reply has none (many servers send none at all).
 */
export function enhancedStatus(response: unknown): { class: number; subject: number; detail: number } | null {
  if (typeof response !== "string") return null;
  const m = /^\d{3}[ -]([245])\.(\d{1,3})\.(\d{1,3})(?!\d)/.exec(response.trim());
  return m ? { class: Number(m[1]), subject: Number(m[2]), detail: Number(m[3]) } : null;
}

/** Subjects of an enhanced code that are about the mail, not the address: x.3 the mail system, x.4 the network, x.7 policy or relaying. */
const THE_MAILS_OWN = new Set([3, 4, 7]);

/**
 * Whether the server refused this one recipient on their own account: a reply at RCPT TO, 4xx or 5xx (no such mailbox,
 * a mailbox full), unless its enhanced status is of class x.7.x, x.3.x or x.4.x (relaying or policy refused, the mail
 * system, the network), which refuses every recipient alike and so is the mail failing. Anything that is not a reply at
 * RCPT TO (connecting, signing in, MAIL FROM, DATA, a timeout) is the mail failing too. A server may refuse relaying with
 * no enhanced code at all, which this can't tell from a bad address: the worker's wake checks for that itself (two or
 * more refused and nobody sent to is the mail failing, sendOwedWelcomes()).
 */
export function refusedThisRecipient(f: SmtpFailure): boolean {
  if (f.code !== "EENVELOPE" || f.command !== "RCPT TO") return false;
  if (typeof f.responseCode !== "number" || f.responseCode < 400 || f.responseCode >= 600) return false;
  const status = enhancedStatus(f.response);
  return status === null || !THE_MAILS_OWN.has(status.subject);
}
