import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { X509Certificate, randomBytes } from "node:crypto";
import { welcomeMessage } from "@/lib/mail/messages";
import { jwtVerify } from "jose";
import { generateCertificate } from "@/lib/auth/certificate-crypto";
import { createGraphSender, clearGraphTokenCache } from "@/lib/mail/graph";
import { MailSendError } from "@/lib/mail/types";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
const seen: Seen[] = [];
let reply: (s: Seen) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.status === 202 ? "" : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { seen.length = 0; clearGraphTokenCache(); });

const TENANT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const okGraph = (s: Seen) => (s.url.includes("/oauth2/") ? { status: 200, body: { access_token: "tok-1", expires_in: 3600 } } : { status: 202, body: null });
const msg = { to: "ana@example.com", subject: "Your FZN Boosters sign-in code: 482913", text: "t", html: "<p>h</p>" };

async function sender() {
  const g = await generateCertificate("graph test");
  const assertion = { privateKeyPem: g.privateKeyPem, thumbprintS256: g.thumbprintS256, thumbprintSha1Base64Url: Buffer.from(g.thumbprintSha1, "hex").toString("base64url") };
  return { g, send: createGraphSender({ tenantId: TENANT, clientId: CLIENT, assertion, mailbox: "webmaster@fznband.org", fromName: "FZN Boosters", endpoints: { login: base, graph: base } }) };
}

describe("Graph sender", () => {
  it("gets an app-only token with the certificate, then sends as the one mailbox without saving a copy", async () => {
    reply = okGraph;
    const { g, send } = await sender();
    await send(msg);
    const [tokenReq, mailReq] = seen;
    expect(tokenReq!.url).toBe(`/${TENANT}/oauth2/v2.0/token`);
    const form = new URLSearchParams(tokenReq!.body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(form.get("client_secret")).toBeNull();
    await jwtVerify(form.get("client_assertion")!, new X509Certificate(g.certificatePem).publicKey, { audience: `${base}/${TENANT}/oauth2/v2.0/token`, issuer: CLIENT });
    expect(mailReq!.method).toBe("POST");
    expect(mailReq!.url).toBe("/v1.0/users/webmaster%40fznband.org/sendMail");
    expect(mailReq!.headers.authorization).toBe("Bearer tok-1");
    expect(JSON.parse(mailReq!.body)).toEqual({
      message: { subject: msg.subject, body: { contentType: "HTML", content: msg.html }, toRecipients: [{ emailAddress: { address: "ana@example.com" } }],
        from: { emailAddress: { name: "FZN Boosters", address: "webmaster@fznband.org" } } },
      saveToSentItems: false,
    });
  });

  it("carries a file such as a calendar file as a file attachment, its bytes in base64", async () => {
    reply = okGraph;
    const { send } = await sender();
    const calendar = "BEGIN:VCALENDAR\r\nSUMMARY:Car wash, rinse crew é\r\nEND:VCALENDAR\r\n";
    await send({ ...msg, attachments: [{ filename: "volunteer-shift.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH", content: calendar }] });
    const sent = JSON.parse(seen.find((s) => s.url.endsWith("/sendMail"))!.body);
    expect(sent.message.attachments).toEqual([{ "@odata.type": "#microsoft.graph.fileAttachment", name: "volunteer-shift.ics",
      contentType: "text/calendar; charset=utf-8; method=PUBLISH", contentBytes: Buffer.from(calendar, "utf8").toString("base64") }]);
    expect(sent.saveToSentItems).toBe(false);
  });

  // Graph sends the HTML alone (Exchange makes the plain part from it), so a link must be an anchor there: its text and
  // its href both the whole address, alone in its paragraph (the sign-in release, slice SI-4).
  it("sends a mail's link as an anchor of itself, once, in the HTML it sends", async () => {
    reply = okGraph;
    const { send } = await sender();
    const token = randomBytes(32).toString("base64url");
    const url = `https://portal.example.org/sign-in/set-up/${token}`;
    await send(welcomeMessage({ clubName: "FZN Boosters", color: "#005102" }, "ana@example.com", { appUrl: "https://portal.example.org", contact: null, link: { url, life: "7 days", strict: false } }));
    const content = JSON.parse(seen.find((s) => s.url.endsWith("/sendMail"))!.body).message.body.content as string;
    expect(content.split(`<p style="margin:0 0 16px"><a href="${url}">${url}</a></p>`)).toHaveLength(2);
    expect(content.split(token)).toHaveLength(3); // the anchor's href and its text, and nowhere else
  });

  it("reuses the token for the next message", async () => {
    reply = okGraph;
    const { send } = await sender();
    await send(msg); await send(msg);
    expect(seen.filter((s) => s.url.includes("/oauth2/"))).toHaveLength(1);
  });

  it("says which mailbox Microsoft 365 refused, without the message", async () => {
    reply = (s) => (s.url.includes("/oauth2/") ? okGraph(s) : { status: 403, body: { error: { code: "ErrorAccessDenied", message: "Access is denied." } } });
    const { send } = await sender();
    const e = await send(msg).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailSendError);
    expect((e as Error).message).toContain("webmaster@fznband.org");
    expect((e as Error).message).toContain("ErrorAccessDenied");
    expect((e as Error).message).not.toContain("482913");
  });

  it("keeps only a short, plain error code from Graph, and falls back to the HTTP status", async () => {
    const { send } = await sender();
    for (const code of ["x".repeat(300), "<script>alert(1)</script>", "Error Access\nDenied", ""]) {
      reply = (s) => (s.url.includes("/oauth2/") ? okGraph(s) : { status: 400, body: { error: { code, message: "Access is denied." } } });
      const e = await send(msg).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(MailSendError);
      expect((e as Error).message).toBe("Microsoft Graph didn't accept the message (HTTP 400).");
      expect((e as MailSendError).recipientRefused).toBe(false);
    }
    reply = (s) => (s.url.includes("/oauth2/") ? okGraph(s) : { status: 400, body: { error: { code: "ErrorInvalidRecipients" } } });
    const refused = await send(msg).catch((x: unknown) => x);
    expect(refused).toBeInstanceOf(MailSendError);
    expect((refused as Error).message).toBe("Microsoft Graph didn't accept the message (ErrorInvalidRecipients).");
    // The address itself refused: not a failure of the mail (sendOwedWelcomes() goes on with the others).
    expect((refused as MailSendError).recipientRefused).toBe(true);
  });

  it("reports a refused token with its AADSTS code", async () => {
    reply = () => ({ status: 401, body: { error_codes: [700027] } });
    const { send } = await sender();
    await expect(send(msg)).rejects.toThrow(/AADSTS700027/);
  });

  it("drops a token Graph no longer accepts, so the next send gets a new one", async () => {
    let calls = 0;
    reply = (s) => (s.url.includes("/oauth2/") ? okGraph(s) : (calls++ === 0 ? { status: 401, body: { error: { code: "InvalidAuthenticationToken" } } } : { status: 202, body: null }));
    const { send } = await sender();
    await expect(send(msg)).rejects.toThrow(MailSendError);
    await send(msg);
    expect(seen.filter((s) => s.url.includes("/oauth2/"))).toHaveLength(2);
  });
});
