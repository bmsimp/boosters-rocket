import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

const SCRIPT = path.resolve("scripts/poc/deploy.sh");
let dir: string, bin: string, log: string;

function stub(name: string, body: string) {
  const p = path.join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${log.replace(/\\/g, "/")}"\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BR_DIR: dir, BR_HEALTH_TIMEOUT: "2", ...env },
  });
}
const hasFlock = spawnSync("bash", ["-c", "command -v flock"]).status === 0;
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "br-deploy-"));
  bin = path.join(dir, "bin"); mkdirSync(bin);
  log = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, ".env.poc"), "DB_PASSWORD=x\n"); chmodSync(path.join(dir, ".env.poc"), 0o600);
  copyFileSync(path.resolve("docker-compose.poc.yml"), path.join(dir, "docker-compose.poc.yml"));
  stub("git", `case "$1" in status) printf "%s" "\${GIT_DIRTY:-}";; rev-parse) echo abc1234;; *) exit 0;; esac`);
  stub("docker", `
    case "$*" in
      *"run --rm migrate"*) exit \${MIGRATE_FAIL:-0};;
      *" build app"*) exit \${BUILD_FAIL:-0};;
      *"inspect --format {{.Image}}"*) [ -z "\${NO_RUNNING:-}" ] || exit 1; echo "sha256:running123";;
      *"inspect --format {{.State.Health.Status}}"*) if [ -n "\${PRE_HEALTH:-}" ] && [ ! -e "\${BR_DIR}/.recreated" ]; then echo "\${PRE_HEALTH}"; else echo "\${HEALTH:-healthy}"; fi;;
      *"up -d --no-deps --force-recreate app"*) touch "\${BR_DIR}/.recreated"; exit 0;;
      *"image inspect booster-rocket-app:previous"*) exit \${NO_PREVIOUS:-0};;
      *"image inspect booster-rocket-app:current"*) exit \${NO_CURRENT:-0};;
      *) exit 0;;
    esac`);
});

describe("scripts/poc/deploy.sh", () => {
  it("pulls, builds, migrates, recreates the app and waits for health, in that order", () => {
    const r = run();
    expect(r.status).toBe(0);
    const c = calls();
    const order = ["git pull --ff-only", "compose -f docker-compose.poc.yml --env-file .env.poc build app",
      "run --rm migrate", "docker image tag sha256:running123 booster-rocket-app:previous", "up -d --no-deps --force-recreate app", "inspect --format {{.State.Health.Status}}"];
    let at = -1;
    for (const step of order) { const i = c.indexOf(step, at + 1); expect(i, `missing or out of order: ${step}\n${c}`).toBeGreaterThan(at); at = i; }
    expect(r.stdout).toContain("Deployed abc1234");
  });

  it("refuses when the checkout has local changes, before touching anything", () => {
    const r = run([], { GIT_DIRTY: " M src/app/page.tsx\n" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("local changes");
    expect(calls()).not.toContain("docker");
    expect(calls()).not.toContain("git pull");
  });

  it("stops when migrations fail and leaves the running app alone", () => {
    const r = run([], { MIGRATE_FAIL: "1" });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("Migrations failed");
    expect(calls()).not.toContain("up -d");
    expect(calls()).not.toContain("booster-rocket-app:previous");
  });

  it("stops when the build fails, before migrating or touching the app", () => {
    const r = run([], { BUILD_FAIL: "1" });
    expect(r.status).toBe(7);
    expect(r.stderr).toContain("build failed");
    expect(calls()).not.toContain("run --rm migrate");
    expect(calls()).not.toContain("up -d");
    expect(calls()).not.toContain("image tag");
  });

  it("fails loudly when the app never becomes healthy", () => {
    const r = run([], { HEALTH: "unhealthy" });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("didn't become healthy");
  });

  it("refuses when .env.poc is missing", () => {
    rmSync(path.join(dir, ".env.poc"));
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(".env.poc is missing");
    expect(calls()).not.toContain("docker");
  });

  it.skipIf(process.platform === "win32")("refuses when .env.poc is readable by others", () => {
    chmodSync(path.join(dir, ".env.poc"), 0o644);
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("chmod 600");
  });

  it("rolls back to the previous image", () => {
    const r = run(["--rollback"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("docker image tag booster-rocket-app:previous booster-rocket-app:current");
    expect(calls()).toContain("up -d --no-deps --force-recreate app");
    expect(calls()).not.toContain("git pull");
    expect(r.stdout).toContain("migrations are not reversed");
  });

  it("says plainly when there is nothing to roll back to, and changes nothing", () => {
    const r = run(["--rollback"], { NO_PREVIOUS: "1" });
    expect(r.status).toBe(5);
    expect(r.stderr).toContain("No previous image");
    expect(calls()).not.toContain("up -d");
    expect(calls()).not.toContain("image tag");
  });

  it("keeps the existing previous image when the running app is unhealthy, and still deploys", () => {
    const r = run([], { PRE_HEALTH: "unhealthy" });
    expect(r.status).toBe(0);
    expect(calls()).not.toContain("booster-rocket-app:previous");
    expect(calls()).toContain("up -d --no-deps --force-recreate app");
    expect(r.stdout).toContain("previous good image was kept for rollback");
    expect(r.stdout).toContain("Deployed abc1234");
  });

  it("does not tag a previous image when no container is running", () => {
    const r = run([], { NO_RUNNING: "1" });
    expect(r.status).toBe(0);
    expect(calls()).not.toContain("booster-rocket-app:previous");
    expect(calls()).toContain("up -d --no-deps --force-recreate app");
  });

  it.skipIf(!hasFlock)("refuses when another deploy holds the lock", async () => {
    const holder = spawn("bash", ["-c", 'exec 9>"$1/.deploy.lock"; flock 9; echo locked; sleep 5', "_", dir.replace(/\\/g, "/")]);
    try {
      await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
      const r = run();
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Another deploy is running");
      expect(calls()).not.toContain("docker");
    } finally {
      holder.kill();
    }
  });
});
