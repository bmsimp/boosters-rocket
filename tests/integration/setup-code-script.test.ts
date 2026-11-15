import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { verifySetupCode, resetSetupCodeLimiter } from "@/lib/setup/code";
import { getSetupState, updateSetupState } from "@/lib/setup/state";
import { resetDb } from "../helpers/db";

// The script writes to the database this run uses (vitest.config.mts sets DATABASE_URL), where the app code below reads.
const DB = process.env.DATABASE_URL!;
const run = (...args: string[]) => spawnSync("node", ["scripts/setup-code.mjs", ...args], {
  encoding: "utf8", env: { ...process.env, DATABASE_URL: DB, APP_URL: "https://portal.example.org" },
});
const codeFrom = (out: string) => /Setup code: ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)?.[1];

describe("scripts/setup-code.mjs", () => {
  beforeEach(async () => { await resetDb(); resetSetupCodeLimiter(); });

  it("issues a code the app accepts (both sides hash the same way)", async () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("https://portal.example.org/setup");
    expect((await verifySetupCode(codeFrom(r.stdout)!, null)).ok).toBe(true);
  });

  it("replaces the previous code", async () => {
    const first = codeFrom(run().stdout)!;
    const second = codeFrom(run().stdout)!;
    expect((await verifySetupCode(first, null)).ok).toBe(false);
    expect((await verifySetupCode(second, null)).ok).toBe(true);
  });

  it("refuses once setup is finished, and --if-open stays quiet", async () => {
    await updateSetupState({ status: "finished" });
    const r = run();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("reopen-setup.sh");
    const quiet = run("--if-open");
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe("");
  });

  it("--reopen opens setup at the staff step, audits, and issues a code", async () => {
    await updateSetupState({ status: "finished", step: "admin", adminEmail: "a@club.org" });
    const r = run("--reopen");
    expect(r.status).toBe(0);
    expect(await getSetupState()).toMatchObject({ status: "open", step: "staff", adminEmail: "a@club.org" });
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["setup.reopen", "setup.code.issue"]);
    expect(codeFrom(r.stdout)).toBeDefined();
  });
});
