import type { QboEnvironment } from "@/lib/db/schema";

export type QboEndpoints = { authorize: string; token: string; revoke: string; api: Record<QboEnvironment, string> };

const INTUIT: QboEndpoints = {
  authorize: "https://appcenter.intuit.com/connect/oauth2",
  token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revoke: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
  api: { sandbox: "https://sandbox-quickbooks.api.intuit.com", production: "https://quickbooks.api.intuit.com" },
};

/** Where Intuit and QuickBooks live. A function so integration tests can replace it (vi.mock) with a stub server; the app has no other switch. */
export function qboEndpoints(): QboEndpoints { return INTUIT; }

export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_MINOR_VERSION = "75";

/** A QuickBooks or Intuit failure, already reduced to a sentence that is safe to show and a short code (spec §2). */
export class QboError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "QboError"; }
}
