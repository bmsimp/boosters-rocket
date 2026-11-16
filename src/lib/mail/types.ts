/** A file sent with a message, such as a calendar file. `content` is the file's text, sent as UTF-8, or its bytes (a signed PDF). */
export type MailAttachment = { filename: string; contentType: string; content: string | Buffer };
/** An attachment's bytes, as both senders put them in the message. */
export const attachmentBytes = (a: MailAttachment): Buffer => (typeof a.content === "string" ? Buffer.from(a.content, "utf8") : a.content);
export type MailMessage = { to: string; subject: string; text: string; html: string; attachments?: MailAttachment[] };
/** Sends one message; throws MailSendError. */
export type MailSender = (m: MailMessage) => Promise<void>;
/** A send failure. The message is a fixed sentence plus the provider's error code: safe to show staff and to audit, never the body. */
export class MailSendError extends Error {}
export type SmtpSecurity = "starttls" | "tls";
export type StoredMailConfig =
  | { method: "graph"; mailbox: string }
  | { method: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; from: string; passwordCiphertext: string; passwordKeyId: string };
export type MailPurpose = "signin_code" | "welcome" | "email_change_confirm" | "email_change_notice" | "test" | "review_notice" | "volunteer_confirm" | "volunteer_notice" | "form_copy" | "form_reminder";
