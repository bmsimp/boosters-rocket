import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let dir: string, bin: string, log: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "br-poc-"));
  bin = path.join(dir, "bin"); mkdirSync(bin);
  log = path.join(dir, "calls.log");
  mkdirSync(path.join(dir, "scripts", "poc"), { recursive: true });
  for (const f of ["setup.sh", "setup-code.sh", "reopen-setup.sh"]) copyFileSync(path.resolve("scripts/poc", f), path.join(dir, "scripts/poc", f));
  copyFileSync(path.resolve(".env.poc.example"), path.join(dir, ".env.poc.example"));
  const p = path.join(bin, "docker");
  writeFileSync(p, `#!/usr/bin/env bash\necho "docker $*" >> "${log.replace(/\\/g, "/")}"\nexit 0\n`);
  chmodSync(p, 0o755);
});
const run = (script: string, ...args: string[]) => spawnSync("bash", [path.join(dir, "scripts/poc", script), ...args], {
  encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BR_DIR: dir },
});

describe("server setup scripts", { timeout: 30_000 }, () => {
  it("setup.sh generates SETTINGS_ENCRYPTION_KEY", () => {
    expect(run("setup.sh").status).toBe(0);
    const env = readFileSync(path.join(dir, ".env.poc"), "utf8");
    const key = /^SETTINGS_ENCRYPTION_KEY=(.+)$/m.exec(env)?.[1];
    expect(Buffer.from(key!, "base64")).toHaveLength(32);
  });

  it("setup.sh adds the key to an older .env.poc that lacks it, keeping everything else", () => {
    writeFileSync(path.join(dir, ".env.poc"), "APP_URL=https://x\nDB_PASSWORD=keepme\n"); chmodSync(path.join(dir, ".env.poc"), 0o600);
    expect(run("setup.sh").status).toBe(0);
    const env = readFileSync(path.join(dir, ".env.poc"), "utf8");
    expect(env).toContain("DB_PASSWORD=keepme");
    expect(env).toMatch(/^SETTINGS_ENCRYPTION_KEY=.+$/m);
  });

  it("setup.sh backfills the key onto its own line when .env.poc has no final newline", () => {
    writeFileSync(path.join(dir, ".env.poc"), "APP_URL=https://x\nDB_PASSWORD=keepme"); chmodSync(path.join(dir, ".env.poc"), 0o600);
    expect(run("setup.sh").status).toBe(0);
    const lines = readFileSync(path.join(dir, ".env.poc"), "utf8").split("\n");
    expect(lines).toContain("DB_PASSWORD=keepme");
    expect(lines.findIndex((l) => l.startsWith("SETTINGS_ENCRYPTION_KEY="))).toBeGreaterThan(lines.indexOf("DB_PASSWORD=keepme"));
  });

  it.skipIf(process.platform === "win32")("setup.sh keeps .env.poc private after a backfill", () => {
    writeFileSync(path.join(dir, ".env.poc"), "DB_PASSWORD=x\n"); chmodSync(path.join(dir, ".env.poc"), 0o600);
    expect(run("setup.sh").status).toBe(0);
    expect(statSync(path.join(dir, ".env.poc")).mode & 0o777).toBe(0o600);
  });

  it("setup.sh keeps the same key on a second run and never prints it", () => {
    const first = run("setup.sh");
    const key = /^SETTINGS_ENCRYPTION_KEY=(.+)$/m.exec(readFileSync(path.join(dir, ".env.poc"), "utf8"))![1];
    const second = run("setup.sh");
    expect(second.status).toBe(0);
    expect(readFileSync(path.join(dir, ".env.poc"), "utf8")).toContain(`SETTINGS_ENCRYPTION_KEY=${key}\n`);
    for (const r of [first, second]) expect(r.stdout + r.stderr).not.toContain(key);
  });

  it("setup-code.sh runs the code script in the app image; reopen-setup.sh passes --reopen", () => {
    writeFileSync(path.join(dir, ".env.poc"), "DB_PASSWORD=x\n"); chmodSync(path.join(dir, ".env.poc"), 0o600);
    expect(run("setup-code.sh").status).toBe(0);
    expect(run("reopen-setup.sh").status).toBe(0);
    const c = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(c).toContain("compose -f docker-compose.poc.yml --env-file .env.poc run --rm migrate node tools/scripts/setup-code.mjs\n");
    expect(c).toContain("run --rm migrate node tools/scripts/setup-code.mjs --reopen");
  });
});
