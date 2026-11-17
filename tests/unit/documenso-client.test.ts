import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import {
  DOCUMENSO_ERRORS, DocumensoError, EMAILS_OFF, EMAIL_FLAGS, deleteEnvelope, documensoCode, documensoHealth, envelopeIdIn, findDocumentsByExternalId, getEnvelope, isEnvelopeId,
  listTemplates, signingFrameUrl, documentFromTemplate,
} from "@/lib/documenso/client";
import { startDocumensoStub, type DocumensoStub } from "../helpers/documenso-stub";

/**
 * The portal's Documenso client (src/lib/documenso/client.ts): a timeout on every call, errors reduced to short
 * codes, nothing logged, and no token in any message.
 */
let stub: DocumensoStub;
beforeAll(async () => { stub = await startDocumensoStub(); });
afterAll(async () => { await stub.close(); });
beforeEach(() => { stub.reset(); });
const config = () => ({ origin: stub.origin, token: stub.token });
const codeOf = async (call: Promise<unknown>) => { try { await call; return "no error"; } catch (e) { return documensoCode(e); } };

describe("the Documenso client", () => {
  const logged: unknown[][] = [];
  beforeEach(() => {
    logged.length = 0;
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends the API token as the Authorization header, bare, and reads a template with its fields", async () => {
    const template = stub.addTemplate();
    const envelope = await getEnvelope(config(), template.id);
    expect(stub.calls.at(-1)).toMatchObject({ method: "GET", path: `/api/v2/envelope/${template.id}`, auth: stub.token });
    expect(envelope).toMatchObject({ id: template.id, type: "TEMPLATE" });
    expect(envelope.recipients.map((r) => r.role)).toEqual(["SIGNER", "SIGNER"]);
    expect(envelope.fields.find((f) => f.label === "Student name")).toMatchObject({ type: "TEXT", readOnly: true });
    expect(envelope.fields.find((f) => f.type === "SIGNATURE")).toMatchObject({ label: null, readOnly: false });
    expect(await listTemplates(config())).toEqual([{ id: template.id, title: "Commitment form" }]);
  });

  it("reduces every failure to a short code with a fixed sentence", async () => {
    const template = stub.addTemplate();
    expect(await codeOf(getEnvelope({ ...config(), token: "api_wrong" }, template.id))).toBe("unauthorized");
    expect(await codeOf(getEnvelope(config(), "envelope_doesnotexist"))).toBe("not_found");
    stub.rateLimitNext = 1;
    expect(await codeOf(getEnvelope(config(), template.id))).toBe("rate_limited");
    stub.failNext = 1;
    expect(await codeOf(getEnvelope(config(), template.id))).toBe("server");
    expect(await codeOf(deleteEnvelope(config(), template.id))).toBe("not_found"); // the stub refuses to delete a template
    stub.drop = true;
    expect(await codeOf(getEnvelope(config(), template.id))).toBe("unreachable");
    stub.drop = false;
    stub.healthy = false;
    expect(await codeOf(documensoHealth(stub.origin))).toBe("server");
    stub.healthy = true;
    await expect(documensoHealth(stub.origin)).resolves.toBeUndefined();
    expect(Object.keys(DOCUMENSO_ERRORS).sort()).toEqual(["bad_answer", "not_found", "rate_limited", "refused", "server", "timeout", "too_large", "unauthorized", "unreachable"]);
    expect(documensoCode(new Error("anything else"))).toBe("unexpected");
  });

  it("gives up after its timeout", async () => {
    const template = stub.addTemplate();
    stub.delayMs = 400;
    const started = Date.now();
    expect(await codeOf(getEnvelope(config(), template.id, { timeoutMs: 60 }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(350);
  });

  it("says nothing of the token or of Documenso's answer in an error, and logs nothing", async () => {
    const template = stub.addTemplate();
    stub.failNext = 1;
    let thrown: unknown;
    try { await getEnvelope(config(), template.id); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(DocumensoError);
    const said = `${(thrown as Error).message} ${(thrown as Error).stack} ${JSON.stringify(thrown)} ${String((thrown as { cause?: unknown }).cause ?? "")}`;
    expect((thrown as Error).message).toBe("Documenso had an error of its own.");
    for (const secret of [stub.token, "api_should_never_be_shown", "secret-path", "INTERNAL_SERVER_ERROR"]) expect(said).not.toContain(secret);
    await codeOf(getEnvelope({ ...config(), token: "api_wrong" }, template.id));
    stub.drop = true;
    await codeOf(listTemplates(config()));
    expect(logged).toEqual([]);
  });

  it("refuses an answer it doesn't understand, and a redirect", async () => {
    const odd: Server = createServer((req, res) => {
      if (req.url?.includes("redirect")) { res.writeHead(302, { location: `${stub.origin}/api/v2/envelope` }); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url?.includes("envelope_notjson00") ? "<html>hello</html>" : JSON.stringify({ id: 7, recipients: "none" }));
    });
    await new Promise<void>((resolve) => odd.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(odd.address() as AddressInfo).port}`;
    try {
      expect(await codeOf(getEnvelope({ origin, token: "t" }, "envelope_oddshape00"))).toBe("bad_answer");
      expect(await codeOf(getEnvelope({ origin, token: "t" }, "envelope_notjson00"))).toBe("bad_answer");
      // The token goes to the configured address and nowhere a redirect points.
      expect(await codeOf(getEnvelope({ origin, token: "t" }, "envelope_redirect00"))).toBe("unreachable");
      expect(stub.calls).toEqual([]);
    } finally { await new Promise<void>((resolve) => { odd.closeAllConnections(); odd.close(() => resolve()); }); }
  });

  it("puts only an envelope id into an address, and finds one in what staff paste", async () => {
    expect(isEnvelopeId("envelope_qwmtrsbnzkoplaxe")).toBe(true);
    for (const bad of ["", "envelope_", "envelope_../../x", "template_1", "envelope_abc/def", 7, null]) expect(isEnvelopeId(bad)).toBe(false);
    expect(await codeOf(getEnvelope(config(), "../../api/health"))).toBe("not_found");
    expect(await codeOf(deleteEnvelope(config(), "envelope_x?y=1"))).toBe("not_found");
    expect(stub.calls).toEqual([]); // refused before anything was sent
    expect(envelopeIdIn("https://sign.club.example/t/personal_abc/templates/envelope_qwmtrsbnzkoplaxe/edit")).toBe("envelope_qwmtrsbnzkoplaxe");
    expect(envelopeIdIn("  envelope_qwmtrsbnzkoplaxe ")).toBe("envelope_qwmtrsbnzkoplaxe");
    expect(envelopeIdIn("the consent form")).toBeNull();
  });

  it("finds a document by its exact externalId, though Documenso's search matches substrings and wildcards", async () => {
    const template = stub.addTemplate();
    const make = async (externalId: string) => (await documentFromTemplate(config(), { envelopeId: template.id, externalId, distributeDocument: true, recipients: [], prefillFields: [],
      override: { title: "t", distributionMethod: "NONE", emailSettings: EMAILS_OFF, timezone: "UTC", dateFormat: "MM/dd/yyyy", envelopeExpirationPeriod: { disabled: true } } })).id;
    const exact = await make("req_1"), longer = await make("req_12"), wild = await make("reqX1");
    const all = (await (await fetch(`${stub.origin}/api/v2/envelope?type=DOCUMENT&query=req_1`, { headers: { authorization: stub.token } })).json()) as { data: { id: string }[] };
    expect(all.data.map((d) => d.id).sort()).toEqual([exact, longer, wild].sort()); // what Documenso itself answers
    expect((await findDocumentsByExternalId(config(), "req_1")).map((d) => d.id)).toEqual([exact]);
    expect(stub.calls.at(-1)!.query.get("query")).toBe("req_1");
  });

  it("switches off all nine of Documenso's emails, and builds the frame's address with its options in the fragment", () => {
    expect(EMAIL_FLAGS).toHaveLength(9);
    expect(Object.values(EMAILS_OFF)).toEqual(Array(9).fill(false));
    const url = signingFrameUrl("https://sign.club.example", "tok/with?odd#chars", "Ana Rivera");
    const [address, fragment] = url.split("#") as [string, string];
    expect(address).toBe("https://sign.club.example/embed/sign/tok%2Fwith%3Fodd%23chars");
    expect(JSON.parse(decodeURIComponent(Buffer.from(fragment, "base64").toString("utf8")))).toEqual({ name: "Ana Rivera", lockName: true });
  });
});

describe("the Documenso client's source", () => {
  const files = readdirSync("src/lib/documenso").map((f) => `src/lib/documenso/${f}`);
  it("is server-only and writes nothing to the log", () => {
    expect(files).toEqual(["src/lib/documenso/client.ts"]);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).toMatch(/^import "server-only";$/m);
      expect(text, file).not.toMatch(/console\.|process\.stdout|process\.stderr/);
    }
  });
  it("is never imported by a client component, and neither is the forms folder", () => {
    const client = readdirSync("src/app", { recursive: true }).map((f) => `src/app/${String(f).replaceAll("\\", "/")}`).filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(client.length).toBeGreaterThan(10);
    // A type-only import carries no code to the browser; anything else from these folders would.
    const reaching = client.filter((f) => /^import (?!type\b)[^;]*from\s*["']@\/lib\/(documenso|forms)\//m.test(readFileSync(f, "utf8")));
    expect(reaching).toEqual([]);
  });
});
