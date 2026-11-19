import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

// The service's address is the endpoint module's alone, so the test points it at a stub listening on port 0.
const where = vi.hoisted(() => ({ range: "" }));
vi.mock("@/lib/parents/breach-endpoints", () => ({ breachEndpoints: () => ({ range: where.range }) }));

import { checkBreach } from "@/lib/parents/breach-check";

/**
 * The breach check of the sign-in release: it asks the public range service with only the first five characters of
 * the password's SHA-1 hash, with the padding header, and answers found, not found, or not checked. Nothing of the
 * password, its hash or the suffix leaves in the request, the answer or the log.
 */
type Received = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
let server: Server;
let base = "";
const received: Received[] = [];
const held: ServerResponse[] = [];
let answer: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => { res.writeHead(404).end(); };
const logged: unknown[][] = [];

const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex").toUpperCase();
const PASSWORD = "a long phrase nobody else uses";
const HASH = sha1(PASSWORD), PREFIX = HASH.slice(0, 5), SUFFIX = HASH.slice(5);
/** Suffixes that are not the password's, as the service lists them beside it; count 0 is the service's padding. */
const OTHERS = Array.from({ length: 20 }, (_, i) => sha1(`other ${i}`).slice(5)).filter((s) => s !== SUFFIX);
const rangeOf = (entries: [string, number][]) => entries.map(([s, n]) => `${s}:${n}`).join("\r\n");
const answerWith = (status: number, body: string, headers: Record<string, string> = { "content-type": "text/plain" }) => {
  answer = (_req, res) => { res.writeHead(status, headers).end(body); };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => { received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body }); answer(req, res); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  received.length = 0;
  where.range = `${base}/range/`;
  answerWith(404, "");
  logged.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args); });
});
afterEach(() => {
  for (const res of held.splice(0)) res.destroy();
  vi.restoreAllMocks();
  // Nothing is ever written to the log, whatever the service did.
  expect(logged).toEqual([]);
});

/** Each request the stub received, as the four things that must be exactly so. */
const asked = () => received.map((r) => [r.method, r.url, r.headers["add-padding"], r.body]);
/** What `n` checks must each have sent: one GET of the prefix with the padding header and no body, nothing else. */
const rangeAsks = (n: number) => Array.from({ length: n }, () => ["GET", `/range/${PREFIX}`, "true", ""]);

/** What leaves the server and what comes back must hold nothing of the password but the hash's first five characters. */
function expectNothingOfThePassword(...things: unknown[]) {
  const text = JSON.stringify(things);
  for (const secret of [PASSWORD, HASH, SUFFIX, HASH.toLowerCase(), SUFFIX.toLowerCase(), SUFFIX.slice(0, 10)]) expect(text).not.toContain(secret);
}

describe("the breach check", () => {
  it("asks the public Pwned Passwords range service by default", async () => {
    const real = await vi.importActual<typeof import("@/lib/parents/breach-endpoints")>("@/lib/parents/breach-endpoints");
    expect(real.breachEndpoints()).toEqual({ range: "https://api.pwnedpasswords.com/range/" });
  });

  it("sends only the hash's first five characters, uppercase, as a GET with the padding header and no body", async () => {
    // SHA-1 of "password" is 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8: the service is asked for 5BAA6 alone.
    answerWith(200, rangeOf([["1E4C9B93F3F0682250B6CF8331B7EE68FD8", 10_000_000]]));
    expect(await checkBreach("password")).toEqual({ outcome: "found" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "GET", url: "/range/5BAA6", body: "" });
    expect(received[0]!.headers["add-padding"]).toBe("true");
    expect(JSON.stringify(received)).not.toContain("1E4C9B93F3F0682250B6CF8331B7EE68FD8");
  });

  it("answers found when the password's suffix is listed with a count", async () => {
    answerWith(200, rangeOf([...OTHERS.slice(0, 10).map((s) => [s, 0] as [string, number]), [SUFFIX, 3], ...OTHERS.slice(10).map((s) => [s, 7] as [string, number])]));
    const result = await checkBreach(PASSWORD);
    expect(result).toEqual({ outcome: "found" });
    expect(received.map((r) => [r.method, r.url, r.headers["add-padding"], r.body])).toEqual([["GET", `/range/${PREFIX}`, "true", ""]]);
    expectNothingOfThePassword(received, result);
  });

  it("answers not found when the suffix isn't listed, or is listed only as padding (a count of 0)", async () => {
    answerWith(200, rangeOf(OTHERS.map((s) => [s, 5])));
    expect(await checkBreach(PASSWORD)).toEqual({ outcome: "not_found" });
    answerWith(200, `${rangeOf([[SUFFIX, 0], ...OTHERS.map((s) => [s, 0] as [string, number])])}\r\n`);
    expect(await checkBreach(PASSWORD)).toEqual({ outcome: "not_found" });
    // The service writes hashes in capitals; one in small letters is the same hash.
    answerWith(200, rangeOf([[SUFFIX.toLowerCase(), 2]]));
    expect(await checkBreach(PASSWORD)).toEqual({ outcome: "found" });
    expect(asked()).toEqual(rangeAsks(3));
    expectNothingOfThePassword(received);
  });

  it("could not check when the service answers with an error", async () => {
    for (const status of [500, 503, 429, 404, 400]) {
      answerWith(status, rangeOf([[SUFFIX, 3]]));
      const result = await checkBreach(PASSWORD);
      expect(result, String(status)).toEqual({ outcome: "not_checked", why: "bad_answer" });
      expectNothingOfThePassword(result);
    }
    expect(asked()).toEqual(rangeAsks(5));
  });

  it("could not check when the service is too slow", async () => {
    answer = (_req, res) => { held.push(res); }; // never answers while the test runs
    const result = await checkBreach(PASSWORD, { timeoutMs: 200 });
    expect(result).toEqual({ outcome: "not_checked", why: "timeout" });
    expect(asked()).toEqual(rangeAsks(1));
    expectNothingOfThePassword(result, received);
  });

  it("could not check when the service can't be reached, or answers with a redirect, which is not followed", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    where.range = `http://127.0.0.1:${port}/range/`;
    expect(await checkBreach(PASSWORD)).toEqual({ outcome: "not_checked", why: "unreachable" });

    where.range = `${base}/range/`;
    answerWith(302, "", { location: `${base}/elsewhere/` });
    expect(await checkBreach(PASSWORD)).toEqual({ outcome: "not_checked", why: "unreachable" });
    expect(asked()).toEqual(rangeAsks(1));
  });

  it("could not check when the answer is not a range answer, and never reads a half-understood one as not found", async () => {
    const odd = [
      "",
      "\r\n",
      "<html><body>Service unavailable</body></html>",
      "not a range answer",
      `${SUFFIX}`,                                   // no count
      `${SUFFIX}:many`,                              // a count that isn't a number
      `${SUFFIX.slice(1)}:3`,                        // a suffix one character short
      `${SUFFIX}A:3`,                                // one character long
      `${rangeOf(OTHERS.map((s) => [s, 1]))}\r\nGARBAGE\r\n${SUFFIX}:3`, // a line it can't read, then the suffix
      `${rangeOf(OTHERS.map((s) => [s, 1]))}\r\n\r\n${rangeOf([[SUFFIX, 3]])}`, // an empty line inside the answer
      JSON.stringify({ suffix: SUFFIX, count: 3 }),
      // Larger than any answer the service gives, though every line is well formed.
      rangeOf(Array.from({ length: 26_000 }, (_, i) => [i === 25_000 ? SUFFIX : OTHERS[i % OTHERS.length]!, 1] as [string, number])),
    ];
    for (const body of odd) {
      answerWith(200, body);
      const result = await checkBreach(PASSWORD);
      expect(result, body.slice(0, 60)).toEqual({ outcome: "not_checked", why: "bad_answer" });
      expectNothingOfThePassword(result);
    }
    expect(asked()).toEqual(rangeAsks(odd.length));
  });
});
