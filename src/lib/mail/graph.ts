import { signEntraAssertion, CLIENT_ASSERTION_TYPE, type AssertionKey } from "@/lib/auth/client-assertion";
import { MailSendError, attachmentBytes, type MailSender } from "./types";

export type GraphEndpoints = { login: string; graph: string };
export const GRAPH_ENDPOINTS: GraphEndpoints = { login: "https://login.microsoftonline.com", graph: "https://graph.microsoft.com" };
const TIMEOUT_MS = 15_000;

// App-only tokens, per token endpoint + app + certificate, kept until a minute before they expire.
const tokens = new Map<string, { value: string; expiresAt: number }>();
export function clearGraphTokenCache(): void { tokens.clear(); }

/**
 * Sends as one mailbox through Microsoft Graph with the staff app's certificate (spec §3). Exchange Online RBAC for
 * Applications limits the app to that mailbox. The message is JSON with an HTML body and no copy in Sent Items, so the
 * mailbox doesn't collect sign-in codes; Exchange adds the plain-text part when it sends.
 */
export function createGraphSender(o: { tenantId: string; clientId: string; assertion: AssertionKey; mailbox: string; fromName: string; endpoints?: GraphEndpoints }): MailSender {
  const ep = o.endpoints ?? GRAPH_ENDPOINTS;
  const tokenUrl = `${ep.login}/${encodeURIComponent(o.tenantId)}/oauth2/v2.0/token`;
  const cacheKey = `${tokenUrl}|${o.clientId}|${o.assertion.thumbprintS256}`;

  async function token(): Promise<string> {
    const hit = tokens.get(cacheKey);
    if (hit && hit.expiresAt > Date.now() + 60_000) return hit.value;
    const form = new URLSearchParams({
      grant_type: "client_credentials", client_id: o.clientId, scope: "https://graph.microsoft.com/.default",
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await signEntraAssertion({ ...o.assertion, clientId: o.clientId, tokenEndpoint: tokenUrl }),
    });
    let res: Response;
    try {
      res = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch {
      throw new MailSendError("Couldn't reach Microsoft to get permission to send mail.");
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error_codes?: unknown };
    if (!res.ok || typeof body.access_token !== "string") {
      const codes = Array.isArray(body.error_codes) ? body.error_codes.filter((c): c is number => typeof c === "number") : [];
      throw new MailSendError(`Microsoft refused the request to send mail (${codes[0] ? `AADSTS${codes[0]}` : `HTTP ${res.status}`}). Check staff sign-in with Microsoft under Settings, Sign-in.`);
    }
    const ttl = typeof body.expires_in === "number" ? body.expires_in : 3600;
    tokens.set(cacheKey, { value: body.access_token, expiresAt: Date.now() + ttl * 1000 });
    return body.access_token;
  }

  return async (m) => {
    const url = `${ep.graph}/v1.0/users/${encodeURIComponent(o.mailbox)}/sendMail`;
    const payload = {
      message: {
        subject: m.subject, body: { contentType: "HTML", content: m.html },
        toRecipients: [{ emailAddress: { address: m.to } }], from: { emailAddress: { name: o.fromName, address: o.mailbox } },
        // A file such as a calendar file goes as a file attachment, its bytes in base64 (Graph's sendMail takes up to 3 MB this way).
        ...(m.attachments?.length ? { attachments: m.attachments.map((a) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.filename, contentType: a.contentType,
          contentBytes: attachmentBytes(a).toString("base64") })) } : {}),
      },
      saveToSentItems: false,
    };
    const bearer = await token();
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch {
      throw new MailSendError("Couldn't reach Microsoft Graph to send mail.");
    }
    if (res.status === 202) return;
    if (res.status === 401) tokens.delete(cacheKey);
    const err = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
    // Graph's codes are short names (ErrorAccessDenied). Anything else isn't kept: this sentence is stored and shown to staff.
    const code = typeof err.error?.code === "string" && /^[A-Za-z0-9_.]{1,80}$/.test(err.error.code) ? err.error.code : `HTTP ${res.status}`;
    throw new MailSendError(res.status === 403 || code === "ErrorAccessDenied"
      ? `Microsoft 365 refused to send as ${o.mailbox} (${code}). Check that mail was set up for this mailbox (the staff script's -SetUpMail part, or the steps by hand), and allow up to 2 hours after a change.`
      : `Microsoft Graph didn't accept the message (${code}).`, code === "ErrorInvalidRecipients");
  };
}
