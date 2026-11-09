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
export type CertificateViewJson = { thumbprintSha1: string; notAfter: string };
export type SummaryView = {
  config: Record<string, string>; credentialUpdatedAt: string; expiresAt: string | null; readable: boolean;
  certificate: CertificateViewJson | null; pendingCertificate: CertificateViewJson | null; pendingReadable: boolean;
};
const certView = (c: ProviderSummary["certificate"]): CertificateViewJson | null =>
  (c ? { thumbprintSha1: c.thumbprintSha1, notAfter: c.notAfter.toISOString() } : null);
export const toSummaryView = (s: ProviderSummary): SummaryView => ({
  config: s.config, credentialUpdatedAt: s.credentialUpdatedAt.toISOString(), expiresAt: s.expiresAt?.toISOString() ?? null, readable: s.readable,
  certificate: certView(s.certificate), pendingCertificate: certView(s.pendingCertificate), pendingReadable: s.pendingReadable,
});
