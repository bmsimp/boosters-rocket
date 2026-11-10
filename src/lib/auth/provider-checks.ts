import { type MicrosoftConfig, type CheckedDraft, type CheckResult } from "./providers";
import { signEntraAssertion, CLIENT_ASSERTION_TYPE, type AssertionKey } from "./client-assertion";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchFn = (url, init) => fetch(url, init);
const TIMEOUT_MS = 10_000;
const UNREACHABLE = "Couldn't reach Microsoft to check these values. Check the server's internet connection and try again. Nothing was saved.";

const AADSTS: Record<number, string> = {
  700027: "Microsoft doesn't have this certificate on the app yet. Upload it (or run the script), wait a minute, and try again.",
  700024: "The server's clock looks wrong, so Microsoft refused the certificate. Check the server's time.",
  700016: "Microsoft doesn't know that Application (client) ID in this tenant. Check the client ID, and that the tenant ID is the tenant the app was registered in.",
  90002: "Microsoft can't find that tenant. Check the Directory (tenant) ID.",
  900023: "That tenant ID isn't valid. Copy the Directory (tenant) ID from the tenant's Overview page.",
};

type Credential = { secret: string } | { assertion: AssertionKey };

async function clientCredentials(tokenUrl: string, clientId: string, credential: Credential, f: FetchFn): Promise<CheckResult> {
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, scope: "https://graph.microsoft.com/.default" });
  if ("secret" in credential) form.set("client_secret", credential.secret);
  else {
    // The assertion's audience is this exact token endpoint, so it can't be replayed anywhere else.
    form.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
    form.set("client_assertion", await signEntraAssertion({ ...credential.assertion, clientId, tokenEndpoint: tokenUrl }));
  }
  let res: Response;
  try {
    res = await f(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // A redirect could forward the credential to another host; fetch throws instead, which reads as unreachable.
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

export function checkMicrosoft(c: MicrosoftConfig, assertion: AssertionKey, f: FetchFn = defaultFetch): Promise<CheckResult> {
  return clientCredentials(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, c.clientId, { assertion }, f);
}

/** Google has no credential check that works without a user, so its format is checked when parsing; Step 3 proves it. */
export async function checkGoogle(): Promise<CheckResult> {
  return { ok: true };
}

export function checkFor(draft: CheckedDraft, f: FetchFn = defaultFetch): Promise<CheckResult> {
  switch (draft.key) {
    case "staff-microsoft": return checkMicrosoft(draft.config, draft.assertion, f);
    case "staff-google": return checkGoogle();
  }
}
