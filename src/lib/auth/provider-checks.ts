import { parentDiscoveryUrl, type MicrosoftConfig, type ParentConfig, type CheckedDraft, type CheckResult } from "./providers";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchFn = (url, init) => fetch(url, init);
const TIMEOUT_MS = 10_000;
const UNREACHABLE = "Couldn't reach Microsoft to check these values. Check the server's internet connection and try again. Nothing was saved.";

const AADSTS: Record<number, string> = {
  7000215: "Microsoft rejected the client secret. Copy the secret's Value (not its Secret ID). If you just created it, wait a few minutes and try again — new secrets can take up to 15 minutes to start working.",
  7000222: "That client secret has expired. Create a new one and paste it here.",
  700016: "Microsoft doesn't know that Application (client) ID in this tenant. Check the client ID, and that the tenant ID is the tenant the app was registered in.",
  90002: "Microsoft can't find that tenant. Check the Directory (tenant) ID.",
  900023: "That tenant ID isn't valid. Copy the Directory (tenant) ID from the tenant's Overview page.",
};

async function clientCredentials(tokenUrl: string, clientId: string, secret: string, f: FetchFn): Promise<CheckResult> {
  let res: Response;
  try {
    res = await f(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret, scope: "https://graph.microsoft.com/.default" }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // A redirect could forward the secret to another host; fetch throws instead, which reads as unreachable.
      redirect: "error",
    });
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  if (res.ok) return { ok: true };
  let body: { error_codes?: unknown } = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  const codes = Array.isArray(body.error_codes) ? body.error_codes.filter((c): c is number => typeof c === "number") : [];
  for (const c of codes) if (AADSTS[c]) return { ok: false, message: AADSTS[c] };
  if (res.status >= 500) return { ok: false, message: UNREACHABLE };
  const which = codes[0] ? `AADSTS${codes[0]}` : `HTTP ${res.status}`;
  return { ok: false, message: `Microsoft refused these values (${which}). Check each value against the app registration.` };
}

export function checkMicrosoft(c: MicrosoftConfig, secret: string, f: FetchFn = defaultFetch): Promise<CheckResult> {
  return clientCredentials(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, c.clientId, secret, f);
}

function isTrustedTokenEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && u.hostname.endsWith(".ciamlogin.com");
  } catch {
    return false;
  }
}

export async function checkParent(c: ParentConfig, secret: string, f: FetchFn = defaultFetch): Promise<CheckResult> {
  const INCOMPLETE = "Microsoft's sign-in details for that tenant look incomplete. Try again in a few minutes.";
  let body: unknown;
  try {
    const res = await f(parentDiscoveryUrl(c), { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    if (res.status === 400 || res.status === 404) {
      return { ok: false, message: "Microsoft has no External ID tenant with that subdomain and tenant ID. Check both on the tenant's Overview page." };
    }
    if (!res.ok) return { ok: false, message: UNREACHABLE };
    body = await res.json();
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  if (typeof body !== "object" || body === null) return { ok: false, message: INCOMPLETE };
  const doc = body as { issuer?: unknown; token_endpoint?: unknown };
  if (typeof doc.issuer !== "string" || !doc.issuer.toLowerCase().includes(c.tenantId)) {
    return { ok: false, message: "That address belongs to a different tenant. Check that the tenant ID and subdomain come from the same tenant." };
  }
  if (typeof doc.token_endpoint !== "string") return { ok: false, message: INCOMPLETE };
  // The client secret goes only to a token endpoint on Microsoft's External ID host, over https.
  if (!isTrustedTokenEndpoint(doc.token_endpoint)) {
    return { ok: false, message: "Microsoft's sign-in details for that tenant point somewhere unexpected, so the secret wasn't sent. Check the tenant subdomain and tenant ID." };
  }
  return clientCredentials(doc.token_endpoint, c.clientId, secret, f);
}

/** Google has no credential check that works without a user, so its format is checked when parsing; Step 3 proves it. */
export async function checkGoogle(): Promise<CheckResult> {
  return { ok: true };
}

export function checkFor(draft: CheckedDraft, f: FetchFn = defaultFetch): Promise<CheckResult> {
  switch (draft.key) {
    case "staff-microsoft": return checkMicrosoft(draft.config, draft.secret, f);
    case "parent-oidc": return checkParent(draft.config, draft.secret, f);
    case "staff-google": return checkGoogle();
  }
}
