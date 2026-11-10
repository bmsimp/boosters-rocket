export const PROVIDER_KEYS = ["staff-microsoft", "staff-google"] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
export const isProviderKey = (s: string): s is ProviderKey => (PROVIDER_KEYS as readonly string[]).includes(s);
/** `replaced`: a Microsoft save switched to a replacement certificate, so the old one can come off the app registration. */
export type SaveOutcome = { ok: true; replaced?: true } | { ok: false; errors: string[] };

/** The non-secret fields each provider's form has, in display order. */
export const PROVIDER_FIELDS: Record<ProviderKey, readonly ("tenantId" | "clientId")[]> = {
  "staff-microsoft": ["tenantId", "clientId"],
  "staff-google": ["clientId"],
};

/** The sign-ins that use an app-generated certificate instead of a client secret. */
export const CERTIFICATE_PROVIDERS: readonly ProviderKey[] = ["staff-microsoft"];
export const usesCertificate = (key: ProviderKey) => CERTIFICATE_PROVIDERS.includes(key);
