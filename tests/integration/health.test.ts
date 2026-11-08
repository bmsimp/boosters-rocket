import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => { vi.resetModules(); vi.doUnmock("@/lib/db/client"); });

describe("GET /api/health", () => {
  it("answers ok when the database responds", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("answers 503 with nothing else when the database is unreachable", async () => {
    vi.doMock("@/lib/db/client", () => ({ db: { execute: async () => { throw new Error("connect ECONNREFUSED secret-host:5432"); } } }));
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe('{"ok":false}');
    expect(body).not.toContain("secret-host");
  });
});
