import { describe, it, expect, vi } from "vitest";

vi.mock("@/env", () => ({ env: { BETTER_AUTH_SECRET: "worker-test-secret-worker-test-secret-123456" } }));

import { workerToken } from "@/lib/jobs/worker-token";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
      expect(seen).toEqual([{ method: "POST", url: "/api/internal/worker", authorization: `Bearer ${workerToken()}` }]);
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

  // Running mode: wait for the first wake to reach the app, then stop the script and check how it ends.
  async function loopThenStop(stopWith: (child: ReturnType<typeof spawn>) => void) {
    let result: { code: number | null; out: string } | undefined;
    await withApp(200, { ok: true, ran: [] }, async (url, seen) => {
      const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, BETTER_AUTH_SECRET: SECRET, WORKER_APP_URL: url }, stdio: ["pipe", "pipe", "pipe"] });
      let out = ""; child.stdout!.on("data", (d) => (out += d)); child.stderr!.on("data", (d) => (out += d));
      const closed = new Promise<number | null>((r) => child.on("close", (c) => r(c)));
      try {
        for (let i = 0; i < 200 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
        expect(seen).toHaveLength(1);
        await new Promise((r) => setTimeout(r, 200)); // let the wake finish
        stopWith(child);
        const code = await Promise.race([closed, new Promise<"hung">((r) => setTimeout(() => r("hung"), 10_000))]);
        expect(code).not.toBe("hung");
        result = { code: code as number | null, out };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); // a failed expect must not leave it running
      }
    });
    return result!;
  }
  it.skipIf(process.platform === "win32")("exits 0 and says it stopped when sent SIGTERM", async () => {
    const r = await loopThenStop((c) => c.kill("SIGTERM"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("worker stopped");
    expect(r.out).not.toContain("unsettled top-level await");
  });
  it("keeps running after its first wake when it has no stdin, as in a container", async () => {
    await withApp(200, { ok: true, ran: [] }, async (url, seen) => {
      const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, BETTER_AUTH_SECRET: SECRET, WORKER_APP_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; child.stdout!.on("data", (d) => (out += d)); child.stderr!.on("data", (d) => (out += d));
      try {
        for (let i = 0; i < 200 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 1500));
        expect(seen).toHaveLength(1);
        expect(child.exitCode).toBeNull();
        expect(out).not.toContain("worker stopped");
      } finally {
        child.kill("SIGKILL"); // also when an expect above fails, so the app stub can close
      }
    });
  });
});
