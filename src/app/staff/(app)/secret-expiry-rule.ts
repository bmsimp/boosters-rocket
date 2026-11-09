import type { ProviderKey, ProviderSummary } from "@/lib/auth/providers";

const WARN_MS = 30 * 24 * 60 * 60 * 1000;
export type ExpiringSecret = { key: ProviderKey; expiresAt: Date | null; unreadable: boolean; pendingCertificate: boolean };

/** `pendingCertificate`: a replacement this server can use is already waiting, so the next step is to add it, not make one. */
export function expiringSecrets(summaries: ProviderSummary[], now = new Date()): ExpiringSecret[] {
  return summaries
    .filter((s) => !s.readable || (s.expiresAt !== null && s.expiresAt.getTime() - now.getTime() < WARN_MS))
    .map((s) => ({ key: s.key as ProviderKey, expiresAt: s.expiresAt, unreadable: !s.readable, pendingCertificate: s.pendingCertificate !== null && s.pendingReadable }));
}

/** What to do about a Microsoft sign-in's certificate. */
export const certificateNextStep = (i: Pick<ExpiringSecret, "pendingCertificate">) => (i.pendingCertificate
  ? "a replacement certificate is ready: add it to the app registration, then select Check and switch under Sign-in."
  : "Use Replace certificate under Sign-in.");
