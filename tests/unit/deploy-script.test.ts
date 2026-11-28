import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

const SCRIPT = path.resolve("scripts/poc/deploy.sh");
let dir: string, bin: string, log: string, backups: string;

function stub(name: string, body: string) {
  const p = path.join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${log.replace(/\\/g, "/")}"\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BR_DIR: dir, BR_HEALTH_TIMEOUT: "2", BR_BACKUP_DIR: backups, BR_DB_WAIT: "1", ...env },
  });
}
const hasFlock = spawnSync("bash", ["-c", "command -v flock"]).status === 0;
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "br-deploy-"));
  bin = path.join(dir, "bin"); mkdirSync(bin);
  log = path.join(dir, "calls.log");
  backups = path.join(dir, "backups");
  writeFileSync(path.join(dir, ".env.poc"), "APP_URL=https://portal.example.org\nDB_PASSWORD=x\n"); chmodSync(path.join(dir, ".env.poc"), 0o600);
  copyFileSync(path.resolve("docker-compose.poc.yml"), path.join(dir, "docker-compose.poc.yml"));
  stub("git", `case "$1" in status) printf "%s" "\${GIT_DIRTY:-}";; rev-parse) echo abc1234;; *) exit 0;; esac`);
  stub("docker", `
    case "$*" in
      *"ps -q db"*) [ -n "\${NO_DB_CONTAINER:-}" ] || echo "db-container-1";;
      *"inspect --format {{.State.Running}}"*) echo true;;
      *" pg_dump "*) [ -z "\${BACKUP_FAIL:-}" ] || exit 1; printf 'PGDMP stand-in for a dump';;
      *"setup-code.mjs"*) echo "\${SETUP_CODE_OUT:-}"; exit \${SETUP_CODE_FAIL:-0};;
      *"run --rm migrate"*) exit \${MIGRATE_FAIL:-0};;
      *" build app"*) exit \${BUILD_FAIL:-0};;
      *"db check"*) exit \${DB_CHECK_FAIL:-0};;
      *"inspect --format {{.Image}}"*) [ -z "\${NO_RUNNING:-}" ] || exit 1; echo "sha256:running123";;
      *"inspect --format {{.State.Health.Status}}"*) if [ -n "\${PRE_HEALTH:-}" ] && [ ! -e "\${BR_DIR}/.recreated" ]; then echo "\${PRE_HEALTH}"; else echo "\${HEALTH:-healthy}"; fi;;
      *"up -d --no-deps --force-recreate app"*) touch "\${BR_DIR}/.recreated"; exit 0;;
      *"image tag booster-rocket-app:rollback-candidate"*) exit \${TAG_PROMOTE_FAIL:-0};;
      *"image inspect booster-rocket-app:previous"*) exit \${NO_PREVIOUS:-0};;
      *"image inspect booster-rocket-app:current"*) exit \${NO_CURRENT:-0};;
      *"up -d --no-deps --force-recreate worker"*) exit \${WORKER_FAIL:-0};;
      *"up -d --no-deps --force-recreate backup"*) echo "backup folder \${BR_BACKUP_DIR:-unset}" >> "${log.replace(/\\/g, "/")}"; exit \${BACKUP_SERVICE_FAIL:-0};;
      *) exit 0;;
    esac`);
});

describe("scripts/poc/deploy.sh", { timeout: 30_000 }, () => {
  it("pulls, builds, migrates, recreates the app and waits for health, in that order", () => {
    const r = run();
    expect(r.status).toBe(0);
    const c = calls();
    const order = ["git pull --ff-only", "image tag booster-rocket-app:current booster-rocket-app:rollback-candidate",
      "compose -f docker-compose.poc.yml --env-file .env.poc build app", "exec db-container-1 pg_dump",
      "run --rm migrate", "image tag booster-rocket-app:rollback-candidate booster-rocket-app:previous", "up -d --no-deps --force-recreate app", "inspect --format {{.State.Health.Status}}", "up -d --no-deps --force-recreate worker"];
    let at = -1;
    for (const step of order) { const i = c.indexOf(step, at + 1); expect(i, `missing or out of order: ${step}\n${c}`).toBeGreaterThan(at); at = i; }
    expect(r.stdout).toContain("Deployed abc1234");
  });

  it("starts the worker after the app is healthy, and a worker that won't start doesn't fail the deploy", () => {
    const ok = run();
    expect(ok.status).toBe(0);
    expect(calls().indexOf("--force-recreate worker")).toBeGreaterThan(calls().indexOf("--force-recreate app"));
    rmSync(log, { force: true });
    const r = run([], { WORKER_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("The worker didn't start. The site is up; check: docker logs booster-rocket-worker");
    expect(r.stdout).toContain("Deployed abc1234.");
  });

  it("starts the backup service after the worker, on the folder it backs up into, and never fails a deploy for it", () => {
    const ok = run();
    expect(ok.status).toBe(0);
    const c = calls();
    expect(c.indexOf("--force-recreate backup")).toBeGreaterThan(c.indexOf("--force-recreate worker"));
    expect(c).toContain(`backup folder ${backups}`);
    rmSync(log, { force: true });
    const r = run([], { BACKUP_SERVICE_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("The backup service didn't start. The site is up; check: docker logs booster-rocket-backup");
    expect(r.stdout).toContain("Deployed abc1234.");
  });

  it("doesn't touch the backup service when the app never becomes healthy", () => {
    const r = run([], { HEALTH: "unhealthy" });
    expect(r.status).toBe(4);
    expect(calls()).not.toContain("--force-recreate backup");
  });

  it("recreates the worker on a rollback too", () => {
    const r = run(["--rollback"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("--force-recreate worker");
  });

  it("doesn't start the worker when the app never becomes healthy", () => {
    const r = run([], { HEALTH: "unhealthy" });
    expect(r.status).toBe(4);
    expect(calls()).not.toContain("--force-recreate worker");
  });

  it("prints a setup code after a healthy deploy while setup is open", () => {
    const r = run([], { SETUP_CODE_OUT: "Setup code: K7QM-2XPA-9RTE" });
    expect(r.status).toBe(0);
    const c = calls();
    expect(c.indexOf("setup-code.mjs --if-open")).toBeGreaterThan(c.indexOf("up -d --no-deps --force-recreate app"));
    expect(r.stdout).toContain("Setup code: K7QM-2XPA-9RTE");
  });

  it("still succeeds when the setup-code check fails, and says how to get a code", () => {
    const r = run([], { SETUP_CODE_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("scripts/poc/setup-code.sh");
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
    expect(calls()).not.toContain("--force-recreate"); // the database is started for the backup; the app and worker are not touched
    expect(calls()).not.toContain("booster-rocket-app:previous");
  });

  it("backs up the database before it migrates, into the folder it was given, keeping the number it was told", () => {
    const r = run([], { BR_BACKUP_KEEP: "5" });
    expect(r.status).toBe(0);
    const c = calls();
    expect(c.indexOf("up -d db")).toBeGreaterThan(c.indexOf("build app"));
    expect(c.indexOf("exec db-container-1 pg_dump -U booster --no-password -d booster --format=custom")).toBeGreaterThan(c.indexOf("up -d db"));
    expect(c.indexOf("run --rm migrate")).toBeGreaterThan(c.indexOf("pg_dump"));
    expect(readdirSync(backups).filter((f) => /^booster-rocket-\d{8}T\d{6}Z\.dump$/.test(f))).toHaveLength(1);
    expect(r.stdout).toContain("Keeping the newest 5 backups");
    expect(r.stdout).toContain("SETTINGS_ENCRYPTION_KEY");
  });

  it("stops when the backup fails: nothing is migrated and the running app is left alone", () => {
    const r = run([], { BACKUP_FAIL: "1" });
    expect(r.status).toBe(8);
    expect(r.stderr).toContain("The backup failed. Nothing was migrated and the running app was not touched.");
    const c = calls();
    expect(c).not.toContain("run --rm migrate");
    expect(c).not.toContain("--force-recreate");
    expect(c).not.toContain("booster-rocket-app:previous");
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
  });

  it("stops when there is no database container to back up", () => {
    const r = run([], { NO_DB_CONTAINER: "1" });
    expect(r.status).toBe(8);
    expect(r.stderr).toContain("couldn't be backed up");
    expect(calls()).not.toContain("run --rm migrate");
    expect(calls()).not.toContain("--force-recreate");
  });

  it("takes no backup on a rollback, which migrates nothing", () => {
    expect(run(["--rollback"]).status).toBe(0);
    expect(calls()).not.toContain("pg_dump");
  });

  it("stops when the build fails, before migrating or touching the app", () => {
    const r = run([], { BUILD_FAIL: "1" });
    expect(r.status).toBe(7);
    expect(r.stderr).toContain("build failed");
    expect(calls()).not.toContain("run --rm migrate");
    expect(calls()).not.toContain("up -d");
    expect(calls()).not.toContain("booster-rocket-app:previous");
  });

  it("stops before building when the database must first be moved to a new Postgres, and says so", () => {
    const r = run([], { DB_CHECK_FAIL: "2" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("can't start on this version until its data is moved");
    const c = calls();
    expect(c.indexOf("run --rm --no-deps -T db check")).toBeGreaterThan(c.indexOf("git pull --ff-only"));
    for (const step of [" build app", "pg_dump", "run --rm migrate", "up -d", "image tag"]) expect(c).not.toContain(step);
  });

  it("asks the database service whether it can start before it builds", () => {
    expect(run().status).toBe(0);
    const c = calls();
    expect(c.indexOf("compose -f docker-compose.poc.yml --env-file .env.poc run --rm --no-deps -T db check")).toBeGreaterThan(-1);
    expect(c.indexOf("run --rm --no-deps -T db check")).toBeLessThan(c.indexOf(" build app"));
  });

  it("fails loudly when the app never becomes healthy", () => {
    const r = run([], { HEALTH: "unhealthy" });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("didn't become healthy");
    expect(calls()).not.toContain("setup-code.mjs");
  });

  it("refuses when .env.poc is missing", () => {
    rmSync(path.join(dir, ".env.poc"));
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(".env.poc is missing");
    expect(calls()).not.toContain("docker");
  });

  it("refuses when .env.poc doesn't say the portal's address, before touching anything", () => {
    for (const env of ["DB_PASSWORD=x\n", "APP_URL=\nDB_PASSWORD=x\n", "APP_URL=portal.example.org\n", "# APP_URL=https://portal.example.org\n"]) {
      writeFileSync(path.join(dir, ".env.poc"), env); chmodSync(path.join(dir, ".env.poc"), 0o600);
      const r = run();
      expect(r.status, env).toBe(2);
      expect(r.stderr).toContain(".env.poc has no APP_URL");
      expect(calls()).not.toContain("docker");
    }
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

  it("keeps deploying when the rollback copy cannot be kept", () => {
    const r = run([], { TAG_PROMOTE_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(calls()).toContain("up -d --no-deps --force-recreate app");
    expect(r.stdout).toContain("Couldn't keep a rollback copy of the running version; the deploy continues.");
    expect(r.stdout).toContain("Deployed abc1234");
  });

  it("makes no candidate tag on a first deploy, and nothing fails", () => {
    const r = run([], { NO_CURRENT: "1", NO_RUNNING: "1" });
    expect(r.status).toBe(0);
    expect(calls()).not.toContain("rollback-candidate booster-rocket-app:previous");
    expect(calls()).not.toContain("booster-rocket-app:current booster-rocket-app:rollback-candidate");
    expect(calls()).toContain("up -d --no-deps --force-recreate app");
  });

  it("removes the candidate tag when the deploy ends", () => {
    run();
    expect(calls()).toContain("image rm booster-rocket-app:rollback-candidate");
  });

  it("does not tag a previous image when no container is running", () => {
    const r = run([], { NO_RUNNING: "1" });
    expect(r.status).toBe(0);
    expect(calls()).not.toContain("booster-rocket-app:previous");
    expect(calls()).toContain("up -d --no-deps --force-recreate app");
  });

  it.skipIf(!hasFlock)("refuses when another deploy holds the lock", async () => {
    const holder = spawn("bash", ["-c", 'exec 9>"$1/.deploy.lock"; flock 9; echo locked; sleep 30', "_", dir.replace(/\\/g, "/")]);
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
