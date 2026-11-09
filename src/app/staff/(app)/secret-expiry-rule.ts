import type { ProviderKey, ProviderSummary } from "@/lib/auth/providers";

const WARN_MS = 30 * 24 * 60 * 60 * 1000;
export function expiringSecrets(summaries: ProviderSummary[], now = new Date()) {
  return summaries
    .filter((s) => !s.readable || (s.secretExpiresAt !== null && s.secretExpiresAt.getTime() - now.getTime() < WARN_MS))
    .map((s) => ({ key: s.key as ProviderKey, expiresAt: s.secretExpiresAt, unreadable: !s.readable }));
}
