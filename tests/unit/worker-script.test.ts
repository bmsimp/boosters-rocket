import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve("scripts/worker.mjs");
const SECRET = "worker-test-secret-worker-test-secret-123456";

async function withApp(status: number, body: unknown, fn: (url: string, seen: { method: string; url: string; authorization: string }[]) => Promise<void>) {
  const seen: { method: string; url: string; authorization: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization ?? "" });
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen); } finally { await new Promise<void>((r) => server.close(() => r())); }
}
const once = (url: string, env: Record<string, string> = {}) => new Promise<{ code: number | null; out: string }>((resolve) => {
  const child = spawn(process.execPath, [SCRIPT, "--once"], { env: { ...process.env, BETTER_AUTH_SECRET: SECRET, WORKER_APP_URL: url, ...env } });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => resolve({ code, out }));
});

describe("scripts/worker.mjs", { timeout: 30_000 }, () => {
  it("posts to the app's worker endpoint with the token derived from BETTER_AUTH_SECRET", async () => {
    await withApp(200, { ok: true, ran: [{ job: "roster.refresh", ok: true }] }, async (url, seen) => {
      const r = await once(`${url}/`);
      expect(r.code).toBe(0);
      expect(seen).toEqual([{ method: "POST", url: "/api/internal/worker", authorization: `Bearer ${createHmac("sha256", SECRET).update("booster-rocket-worker:v1").digest("hex")}` }]);
      expect(r.out).toContain("ran roster.refresh: ok");
      expect(r.out).not.toContain(SECRET);
    });
  });
  it("exits 1 and says so when the app refuses or can't be reached", async () => {
    await withApp(404, {}, async (url) => {
      const r = await once(url);
      expect(r.code).toBe(1);
      expect(r.out).toContain("couldn't reach the app: HTTP 404");
    });
    expect((await once("http://127.0.0.1:9")).code).toBe(1);
  });
  it("refuses to start without BETTER_AUTH_SECRET", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--once"], { encoding: "utf8", env: { ...process.env, BETTER_AUTH_SECRET: "" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("BETTER_AUTH_SECRET is required.");
  });
});
