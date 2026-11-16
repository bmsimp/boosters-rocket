import nodemailer from "nodemailer";
import { MailSendError, attachmentBytes, type MailSender, type SmtpSecurity } from "./types";

/** A fixed sentence and the error code only: nodemailer's own message can quote the server's reply. */
function smtpError(e: unknown): string {
  const err = (e ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof err.code === "string" ? err.code : null;
  const rc = typeof err.responseCode === "number" ? err.responseCode : null;
  if (code === "EAUTH") return "The mail server refused the username or password.";
  if (code === "ETLS") return "Couldn't make an encrypted connection to the mail server. Check the port and the security setting.";
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "EDNS" || code === "ESOCKET") return "Couldn't reach the mail server over an encrypted connection. Check the host, port and security setting.";
  return `The mail server didn't accept the message (${[code, rc].filter((x) => x !== null).join(" ") || "no error code"}).`;
}

/** SMTP with STARTTLS or TLS only, TLS 1.2 or later. `tls.ca` is for tests against a local stub; the app never passes it. */
export function createSmtpSender(o: {
  host: string; port: number; security: SmtpSecurity; username: string; password: string; from: string; fromName: string; tls?: { ca?: string };
}): MailSender {
  return async (m) => {
    const transport = nodemailer.createTransport({
      host: o.host, port: o.port, secure: o.security === "tls", requireTLS: o.security === "starttls",
      auth: { user: o.username, pass: o.password },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
      tls: { minVersion: "TLSv1.2", ...(o.tls?.ca ? { ca: o.tls.ca } : {}) },
      logger: false, debug: false,
    });
    try {
      await transport.sendMail({ from: { name: o.fromName, address: o.from }, to: m.to, subject: m.subject, text: m.text, html: m.html,
        ...(m.attachments?.length ? { attachments: m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: attachmentBytes(a) })) } : {}) });
    } catch (e) {
      throw new MailSendError(smtpError(e));
    } finally {
      transport.close();
    }
  };
}
