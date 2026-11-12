export type MailMessage = { to: string; subject: string; text: string; html: string };
/** Sends one message; throws MailSendError. */
export type MailSender = (m: MailMessage) => Promise<void>;
/** A send failure. The message is a fixed sentence plus the provider's error code: safe to show staff and to audit, never the body. */
export class MailSendError extends Error {}
export type SmtpSecurity = "starttls" | "tls";
export type StoredMailConfig =
  | { method: "graph"; mailbox: string }
  | { method: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; from: string; passwordCiphertext: string; passwordKeyId: string };
export type MailPurpose = "signin_code" | "welcome" | "email_change_confirm" | "email_change_notice" | "test" | "review_notice";
