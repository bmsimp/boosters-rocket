import { loadProviders } from "@/lib/auth/providers";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { createGraphSender } from "./graph";
import { createSmtpSender } from "./smtp";
import { MailSendError, type MailSender, type StoredMailConfig } from "./types";
import type { Brand } from "./messages";

export const SMTP_PASSWORD_AAD = "mail:smtp-password";

/** The sender for the saved settings. Tests replace this module with vi.mock; the app has no other transport. */
export async function buildSender(stored: StoredMailConfig, brand: Brand): Promise<MailSender> {
  if (stored.method === "graph") {
    const ms = (await loadProviders()).staffMicrosoft;
    if (!ms) throw new MailSendError("Staff sign-in with Microsoft isn't set up, so mail can't go through Microsoft 365.");
    return createGraphSender({ tenantId: ms.config.tenantId, clientId: ms.config.clientId, assertion: ms.assertion, mailbox: stored.mailbox, fromName: brand.clubName });
  }
  let password: string;
  try {
    password = secretBox().open({ ciphertext: stored.passwordCiphertext, keyId: stored.passwordKeyId }, SMTP_PASSWORD_AAD);
  } catch (e) {
    if (e instanceof SecretBoxError) throw new MailSendError("The saved SMTP password can't be read with this server's encryption key. Enter it again under Settings, Mail.");
    throw e;
  }
  return createSmtpSender({ host: stored.host, port: stored.port, security: stored.security, username: stored.username, password, from: stored.from, fromName: brand.clubName });
}
