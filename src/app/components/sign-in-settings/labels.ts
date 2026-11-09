import type { ProviderKey, ProviderSummary } from "@/lib/auth/providers";

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  "staff-microsoft": "Staff sign-in with Microsoft",
  "staff-google": "Staff sign-in with Google",
  "parent-oidc": "Parent sign-in",
};
export const FIELD_LABELS: Record<"tenantId" | "clientId" | "tenantSubdomain", string> = {
  tenantId: "Directory (tenant) ID",
  clientId: "Application (client) ID",
  tenantSubdomain: "Tenant subdomain",
};
export type SummaryView = { config: Record<string, string>; secretUpdatedAt: string; secretExpiresAt: string | null; readable: boolean };
export const toSummaryView = (s: ProviderSummary): SummaryView => ({
  config: s.config, secretUpdatedAt: s.secretUpdatedAt.toISOString(), secretExpiresAt: s.secretExpiresAt?.toISOString() ?? null, readable: s.readable,
});
