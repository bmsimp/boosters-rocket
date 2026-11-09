export const PROVIDER_KEYS = ["staff-microsoft", "staff-google", "parent-oidc"] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
export const isProviderKey = (s: string): s is ProviderKey => (PROVIDER_KEYS as readonly string[]).includes(s);
export type SaveOutcome = { ok: true } | { ok: false; errors: string[] };

/** The non-secret fields each provider's form has, in display order. */
export const PROVIDER_FIELDS: Record<ProviderKey, readonly ("tenantId" | "clientId" | "tenantSubdomain")[]> = {
  "staff-microsoft": ["tenantId", "clientId"],
  "staff-google": ["clientId"],
  "parent-oidc": ["tenantSubdomain", "tenantId", "clientId"],
};
