import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

/**
 * The move from Postgres 16 to Postgres 18 (scripts/move-postgres.sh, scripts/postgres-guard.sh), run for real with
 * docker compose, each setup in a compose project of its own:
 * - the developer's compose file: data written by Postgres 16 in the old layout is never met by an empty Postgres 18
 *   (the start is refused, with what to do); the move carries every row across and never writes to the old volume; a
 *   second run changes nothing; going back to 16 works; coming forward again with --again first backs up what
 *   Postgres 18 holds, and stops until told --discard-18 when that holds work done after the move; a move killed
 *   outright leaves nothing with the old data open for writing; a move cut off half way leaves a start that is refused.
 * - a club's deploy/compose.yml: both databases, their owners and roles, the first backup with Postgres 18, databases
 *   the move doesn't carry named before anything is done, and a Postgres 18 backup told apart from a damaged one when
 *   it is loaded into Postgres 16 after going back.
 * docker-compose.poc.yml uses the same guard and script (docs/runbooks/poc-linuxdev.md), rehearsed by hand.
 */
const root = path.resolve(__dirname, "../..");
const OLD_IMAGE = /^OLD_IMAGE="(postgres:16[^"]+)"$/m.exec(readFileSync(path.join(root, "scripts/move-postgres.sh"), "utf8"))![1]!;
const NEW_IMAGE = /^\s+image:\s*(postgres:\S+)/m.exec(readFileSync(path.join(root, "docker-compose.yml"), "utf8"))![1]!;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, seconds = 180) {
  for (let i = 0; i < seconds * 2; i++) { if (ok()) return; await pause(500); }
  throw new Error(`gave up waiting: ${what}`);
}

/** One compose project of a setup, in a folder of its own. */
function setup(kind: "dev" | "deploy", project: string) {
  const p = {
    dir: "", moveDir: "", project,
    /** Where compose runs: the top of the copy for dev, its deploy/ folder for deploy. */
    get cwd() { return kind === "dev" ? this.dir : path.join(this.dir, "deploy"); },
    db: `${project}-db-1`,
    oldVolume: `${project}_${kind === "dev" ? "pgdata" : "db-data"}`,
    newVolume: `${project}_postgres-data`,
    admin: kind === "dev" ? "booster" : "postgres",
    run(cmd: string, args: string[], timeout = 240_000) {
      return spawnSync(cmd, args, { cwd: this.cwd, encoding: "utf8", timeout, env: { ...process.env, COMPOSE_PROJECT_NAME: project } });
    },
    docker(args: string[], timeout?: number) { return this.run("docker", args, timeout); },
    compose(file: "old" | "new", args: string[]) {
      return this.docker(["compose", "-p", project, "-f", file === "old" ? "old-compose.yml" : kind === "dev" ? "docker-compose.yml" : "compose.yml", ...args]);
    },
    move(...args: string[]) { return this.run("bash", [path.join(this.dir, "scripts/move-postgres.sh"), kind, this.moveDir, ...args], 500_000); },
    spawnMove(...args: string[]) {
      return spawn("bash", [path.join(this.dir, "scripts/move-postgres.sh"), kind, this.moveDir, ...args], { cwd: this.cwd, env: { ...process.env, COMPOSE_PROJECT_NAME: project } });
    },
    sql(query: string, db = "booster", user?: string) { return this.docker(["exec", this.db, "psql", "-U", user ?? this.admin, "-d", db, "-Atqc", query]); },
    ready() { return until("Postgres to answer", () => this.docker(["exec", this.db, "pg_isready", "-q", "-h", "127.0.0.1", "-U", this.admin, "-d", "booster"]).status === 0); },
    state() { return this.docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", this.db]).stdout.trim(); },
    /** A refused start: the container stops, or (with a restart policy, as deploy/compose.yml has) waits to try again. */
    async refused() {
      // The state that was seen: a container that restarts may be running again by the time it is read twice.
      let seen = "";
      await until("the database container to stop", () => /^(exited|restarting) /.test(seen = this.state()));
      return seen.replace(/^restarting /, "exited ");
    },
    guardState() { return this.compose("new", ["run", "--rm", "--no-deps", "-T", "db", "state"]).stdout.trim(); },
    /** Every file in a volume, by name and content: whether anything at all changed in it. */
    volumeHash(volume: string) {
      return this.docker(["run", "--rm", "--network", "none", "-v", `${volume}:/d:ro`, "--entrypoint", "bash", NEW_IMAGE, "-c",
        "cd /d && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum"]).stdout.trim();
    },
    /** Running containers that have the old volume open for writing. */
    writersOfOld() {
      const ids = this.docker(["ps", "-q", "--filter", `volume=${this.oldVolume}`]).stdout.split(/\s+/).filter(Boolean);
      return ids.filter((id) => this.docker(["inspect", "--format", `{{range .Mounts}}{{if eq .Name "${this.oldVolume}"}}{{.RW}}{{end}}{{end}}`, id]).stdout.trim() === "true");
    },
    async startOld() { expect(this.compose("old", ["up", "-d", "--force-recreate", "db"]).status).toBe(0); await this.ready(); },
    startNew() { return this.compose("new", ["up", "-d", "--force-recreate", "db"]); },
    tearDown() {
      if (!this.dir) return;
      for (const c of ["move-probe", "move-copy", "move-postgres-16", "move-postgres-18-before", "move-postgres-18"]) this.docker(["rm", "-f", `${project}-${c}`]);
      this.compose("new", ["down", "-v", "--remove-orphans"]);
      this.compose("old", ["down", "-v", "--remove-orphans"]);
      this.docker(["volume", "rm", this.oldVolume, this.newVolume, `${project}-move-copy-16`]);
      rmSync(this.dir, { recursive: true, force: true });
    },
  };
  return p;
}

function copyScripts(dir: string) {
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const f of ["move-postgres.sh", "postgres-guard.sh", "backup.sh", "restore.sh", "backup-schedule.sh", "backup-agent.sh"]) copyFileSync(path.join(root, "scripts", f), path.join(dir, "scripts", f));
}
function pullImages(docker: (args: string[], timeout?: number) => { status: number | null }) {
  for (const image of [OLD_IMAGE, NEW_IMAGE]) {
    const there = docker(["image", "inspect", image]).status === 0 || docker(["pull", "-q", image], 280_000).status === 0;
    expect(there, `docker can't run ${image}`).toBe(true);
  }
}

describe("moving the developer's database from Postgres 16 to Postgres 18", { timeout: 600_000 }, () => {
  const s = setup("dev", `br-move-${process.pid}-${randomBytes(3).toString("hex")}`);
  const kept = () => path.join(s.moveDir, "postgres-18-before-again");

  /** The development compose file as it was before the move: Postgres 16 with its data at the root of the volume. */
  const OLD_COMPOSE = `services:
  db:
    image: ${OLD_IMAGE}
    environment:
      POSTGRES_USER: booster
      POSTGRES_PASSWORD: booster
      POSTGRES_DB: booster
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`;

  beforeAll(() => {
    pullImages((a, t) => spawnSync("docker", a, { encoding: "utf8", timeout: t ?? 240_000 }));
    s.dir = mkdtempSync(path.join(tmpdir(), "br-move-"));
    s.moveDir = path.join(s.dir, "moving");
    copyScripts(s.dir);
    mkdirSync(path.join(s.dir, "docker/initdb"), { recursive: true });
    copyFileSync(path.join(root, "docker/initdb/01-test-db.sql"), path.join(s.dir, "docker/initdb/01-test-db.sql"));
    // The same file, with no fixed port: tests run beside each other and beside the developer's own database.
    const current = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
    expect(current).toMatch(/^\s+ports: .*$/m);
    writeFileSync(path.join(s.dir, "docker-compose.yml"), current.replace(/^\s+ports: .*\n/m, ""));
    writeFileSync(path.join(s.dir, "old-compose.yml"), OLD_COMPOSE);
  }, 300_000);

  afterAll(() => s.tearDown(), 300_000);

  it("refuses to start Postgres 18 beside data Postgres 16 left, says what to do, and changes nothing", async () => {
    await s.startOld();
    expect(s.sql(`create table family_note (id serial primary key, body text not null);
      insert into family_note (body) select 'note ' || g from generate_series(1, 250) g;
      create table audit_log (id bigserial primary key, at timestamptz not null default now(), action text not null);
      insert into audit_log (action) select 'on 16 ' || g from generate_series(1, 5) g`).status).toBe(0);
    expect(s.compose("old", ["stop"]).status).toBe(0);
    const before = s.volumeHash(s.oldVolume);

    s.startNew();
    expect(await s.refused()).toBe("exited 2");
    const logs = s.compose("new", ["logs", "db"]).stdout;
    expect(logs).toContain("Postgres was NOT started, and no data was changed or deleted.");
    expect(logs).toContain("Starting here would make a new, empty database");
    expect(logs).toContain('What to do: AGENTS.md, Tests, "Moving the local database to Postgres 18"');
    expect(s.compose("new", ["run", "--rm", "--no-deps", "-T", "db", "check"]).status).toBe(2);
    expect(s.volumeHash(s.oldVolume)).toBe(before);
    expect(s.guardState()).toMatch(/^old=yes new=empty same=- fingerprint=[0-9a-f]{64} newdata=no moved=-$/m);
  });

  it("moves every row to Postgres 18 without writing a byte to the old volume, and leaves nothing of its own behind", async () => {
    const before = s.volumeHash(s.oldVolume);
    const r = s.move();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Copying the Postgres 16 data");
    expect(r.stdout).toContain("every one with the same number of rows as before");
    expect(r.stdout).toContain("The move is done");
    // The old data, the control file Postgres 16 writes at every start and stop with it, byte for byte as it was.
    expect(s.volumeHash(s.oldVolume)).toBe(before);
    expect(s.docker(["volume", "inspect", `${s.project}-move-copy-16`]).status).not.toBe(0);
    expect(s.docker(["ps", "-aq", "--filter", `label=booster-rocket.move=${s.project}`]).stdout.trim()).toBe("");
    expect(s.startNew().status).toBe(0);
    await s.ready();
    expect(Number(s.sql("show server_version_num").stdout.trim())).toBeGreaterThanOrEqual(180000);
    expect(s.sql("select count(*), max(body) from family_note").stdout.trim()).toBe("250|note 99");
    expect(s.docker(["run", "--rm", "--network", "none", "-v", `${s.oldVolume}:/d:ro`, "--entrypoint", "cat", NEW_IMAGE, "/d/PG_VERSION"]).stdout.trim()).toBe("16");
    expect(s.guardState()).toMatch(/ same=yes .* newdata=yes moved=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("run a second time, changes nothing and leaves Postgres 18 running", () => {
    const r = s.move();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("already moved to Postgres 18");
    expect(s.state()).toBe("running 0");
  });

  it("after going back to 16, backs up what 18 holds before --again, and replaces it only with --discard-18", async () => {
    // Work done on Postgres 18 after the move, then Postgres 16 used again.
    expect(s.sql("insert into family_note (body) values ('written on 18 after the move'); insert into audit_log (action) values ('on 18')").status).toBe(0);
    expect(s.compose("new", ["stop"]).status).toBe(0);
    await s.startOld();
    expect(Number(s.sql("show server_version_num").stdout.trim())).toBeLessThan(170000);
    expect(s.sql("select count(*) from family_note").stdout.trim()).toBe("250");
    expect(s.sql("insert into family_note (body) values ('written on 16 after going back')").status).toBe(0);
    expect(s.compose("old", ["stop"]).status).toBe(0);

    s.startNew();
    expect(await s.refused()).toBe("exited 2");
    const logs = s.compose("new", ["logs", "--tail", "16", "db"]).stdout;
    expect(logs).toContain("Postgres 16 has been started on the old data since");
    expect(logs).toContain("It first backs up what Postgres 18");
    expect(logs).not.toContain("older copy");
    const without = s.move();
    expect(without.status).toBe(2);
    expect(without.stderr).toContain("--again");

    // When the backup of what Postgres 18 holds can't be made, nothing is replaced. The previous version is running, as
    // on the proof of concept's host: the move stops it first, and the old data's fingerprint is taken after that.
    await s.startOld();
    writeFileSync(kept(), "in the way");
    const blocked = s.move("--again");
    expect(blocked.status, blocked.stderr).toBe(4);
    expect(blocked.stderr).toContain("The backup of what Postgres 18 holds failed, so nothing was replaced");
    expect(s.guardState()).toMatch(/ new=moved same=no .* newdata=yes /);
    rmSync(kept());

    // Postgres 18 holds work done after the move: backed up, then a choice, and nothing replaced.
    const asked = s.move("--again");
    expect(asked.status, asked.stderr).toBe(2);
    expect(asked.stderr).toContain("Postgres 18 may hold work done after the move");
    expect(asked.stderr).toContain("--again --discard-18");
    const dumps = readdirSync(kept()).filter((f) => /^booster-rocket-\d{8}T\d{6}Z\.dump$/.test(f));
    expect(dumps).toHaveLength(1);
    expect(asked.stderr).toContain(dumps[0]!);
    expect(s.guardState()).toMatch(/ new=moved same=no .* newdata=yes /);

    const again = s.move("--again", "--discard-18");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("Setting aside the work done on Postgres 18");
    expect(s.startNew().status).toBe(0);
    await s.ready();
    expect(s.sql("select count(*) from family_note where body = 'written on 16 after going back'").stdout.trim()).toBe("1");
    expect(s.sql("select count(*) from family_note where body = 'written on 18 after the move'").stdout.trim()).toBe("0");

    // The work done on Postgres 18 is in the backup the move made of it first.
    const newest = readdirSync(kept()).filter((f) => f.startsWith("booster-rocket-")).sort().at(-1)!;
    const restored = spawnSync("bash", [path.join(s.dir, "scripts/restore.sh"), path.join(kept(), newest), "kept_check"],
      { cwd: s.dir, encoding: "utf8", env: { ...process.env, BR_DB_CONTAINER: s.db, BR_DB_USER: "booster" } });
    expect(restored.status, restored.stderr).toBe(0);
    expect(s.sql("select count(*) from family_note where body = 'written on 18 after the move'", "kept_check").stdout.trim()).toBe("1");
    expect(s.sql("drop database kept_check", "postgres").status).toBe(0);
  });

  it("killed outright while it backs up, leaves nothing with the old data open for writing, and going back still works", async () => {
    expect(s.compose("new", ["stop"]).status).toBe(0);
    await s.startOld();
    expect(s.sql("insert into family_note (body) values ('written before the cut-off moves')").status).toBe(0);
    expect(s.compose("old", ["stop"]).status).toBe(0);
    const before = s.volumeHash(s.oldVolume);

    const child = s.spawnMove("--again");
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", () => {});
    const exited = new Promise((r) => child.on("exit", r));
    await until("the move to start backing up", () => out.includes("Backing up with Postgres 16's own tools"), 300);
    child.kill("SIGKILL");
    await exited;

    // Its own Postgres 16 may still run, but on its copy: nothing has the old volume open for writing.
    expect(s.writersOfOld()).toEqual([]);
    expect(s.volumeHash(s.oldVolume)).toBe(before);
    const stopped = s.run("bash", [path.join(s.dir, "scripts/move-postgres.sh"), "dev", "--stop"]);
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(stopped.stdout).toMatch(/Stopped and removed what a move had left:.*move-copy-16/);
    expect(s.docker(["volume", "inspect", `${s.project}-move-copy-16`]).status).not.toBe(0);
    expect(s.run("bash", [path.join(s.dir, "scripts/move-postgres.sh"), "dev", "--stop"]).stdout).toContain("Nothing of a move was left here");
    expect(s.volumeHash(s.oldVolume)).toBe(before);
  });

  it("cut off half way, leaves a start that is refused; run again, it finishes", async () => {
    const child = s.spawnMove("--again");
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", () => {});
    const exited = new Promise((r) => child.on("exit", r));
    await until("the move to start Postgres 18", () => out.includes("Starting Postgres 18 on its own volume"), 300);
    child.kill("SIGKILL");
    await exited;

    s.startNew();
    expect(await s.refused()).toBe("exited 2");
    expect(s.compose("new", ["logs", "--tail", "12", "db"]).stdout).toContain("was started and did not finish");
    const r = s.move();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("didn't finish: starting again from the Postgres 16 data");
    expect(s.startNew().status).toBe(0);
    await s.ready();
    expect(s.sql("select count(*) from family_note").stdout.trim()).toBe("252");
  });
});

describe("moving a club's installation (deploy/compose.yml) from Postgres 16 to Postgres 18", { timeout: 600_000 }, () => {
  const s = setup("deploy", `br-move-deploy-${process.pid}-${randomBytes(3).toString("hex")}`);
  const PASSWORDS = { POSTGRES_SUPERUSER_PASSWORD: `su-${randomBytes(6).toString("hex")}`, PORTAL_DB_PASSWORD: `portal-${randomBytes(6).toString("hex")}`, DOCUMENSO_DB_PASSWORD: `doc-${randomBytes(6).toString("hex")}` };
  let backups = "";

  /** deploy/compose.yml's db service as it was before the move: Postgres 16, its data at the root of db-data. */
  const OLD_COMPOSE = `services:
  db:
    image: ${OLD_IMAGE}
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: \${POSTGRES_SUPERUSER_PASSWORD}
      PORTAL_DB_PASSWORD: \${PORTAL_DB_PASSWORD}
      DOCUMENSO_DB_PASSWORD: \${DOCUMENSO_DB_PASSWORD}
    volumes:
      - db-data:/var/lib/postgresql/data
      - ./initdb:/docker-entrypoint-initdb.d:ro
volumes:
  db-data:
`;
  /** A login over TCP with a role's own password, as the portal and Documenso log in. */
  const login = (user: string, password: string, db: string, query: string) =>
    s.docker(["exec", "-e", `PGPASSWORD=${password}`, s.db, "psql", "-h", "127.0.0.1", "-U", user, "-d", db, "-Atqc", query]);

  beforeAll(() => {
    pullImages((a, t) => spawnSync("docker", a, { encoding: "utf8", timeout: t ?? 240_000 }));
    s.dir = mkdtempSync(path.join(tmpdir(), "br-move-deploy-"));
    s.moveDir = path.join(s.dir, "moving");
    backups = path.join(s.dir, "backups");
    mkdirSync(backups);
    copyScripts(s.dir);
    mkdirSync(path.join(s.dir, "deploy/initdb"), { recursive: true });
    copyFileSync(path.join(root, "deploy/initdb/10-databases.sql"), path.join(s.dir, "deploy/initdb/10-databases.sql"));
    const compose = readFileSync(path.join(root, "deploy/compose.yml"), "utf8");
    writeFileSync(path.join(s.dir, "deploy/compose.yml"), compose);
    writeFileSync(path.join(s.dir, "deploy/old-compose.yml"), OLD_COMPOSE);
    writeFileSync(path.join(s.dir, "cert.p12"), "not a certificate: Documenso isn't started here");
    // Every setting the file insists on, with the values this test needs where it reads them.
    const env: Record<string, string> = {};
    for (const m of compose.matchAll(/\$\{([A-Z_]+):\?/g)) env[m[1]!] = "x";
    Object.assign(env, PASSWORDS, {
      APP_URL: "http://localhost:3000", DOCUMENSO_URL: "http://localhost:3001", CLUB_TIME_ZONE: "UTC", CLIENT_IP_HEADER: "none",
      DOCUMENSO_SMTP_PORT: "25", DOCUMENSO_SIGNING_CERTIFICATE: path.join(s.dir, "cert.p12").replaceAll("\\", "/"),
      BACKUP_DIR: backups.replaceAll("\\", "/"), BOOSTER_ROCKET_IMAGE: "booster-rocket-not-started:here",
    });
    writeFileSync(path.join(s.dir, "deploy/.env"), Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(""));
  }, 300_000);

  afterAll(() => s.tearDown(), 300_000);

  it("refuses the new files' start beside Postgres 16's data, naming the club's runbook section", async () => {
    await s.startOld();
    expect(s.sql(`create table family_note (id serial primary key, body text not null);
      insert into family_note (body) select 'note ' || g from generate_series(1, 120) g;
      create table audit_log (id bigserial primary key, at timestamptz not null default now(), action text not null);
      insert into audit_log (action) values ('on 16')`, "booster", "booster").status).toBe(0);
    expect(s.sql(`create table "Envelope" (id serial primary key, title text not null);
      insert into "Envelope" (title) select 'form ' || g from generate_series(1, 30) g`, "documenso", "documenso").status).toBe(0);
    expect(s.sql("create database booster_restore_check", "postgres").status).toBe(0);
    expect(s.compose("old", ["stop"]).status).toBe(0);

    s.startNew();
    expect(await s.refused()).toBe("exited 2");
    const logs = s.compose("new", ["logs", "db"]).stdout;
    expect(logs).toContain("Postgres was NOT started, and no data was changed or deleted.");
    expect(logs).toContain('What to do: docs/runbooks/updates.md, the section "Moving to a new major version of Postgres"');
  });

  it("names a database it wouldn't carry before it changes anything, and leaves it behind only when told", () => {
    const named = s.move();
    expect(named.status, named.stderr).toBe(2);
    expect(named.stderr).toContain("the database booster_restore_check");
    expect(named.stderr).toContain("--leave-others");
    expect(s.guardState()).toMatch(/^old=yes new=empty /m);
  });

  it("moves both databases with their owners and roles, and makes the first backup with Postgres 18", async () => {
    const before = s.volumeHash(s.oldVolume);
    const r = s.move("--leave-others");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("the database booster_restore_check");
    expect(r.stdout).toMatch(/booster: 2 tables, every one with the same number of rows as before\./);
    expect(r.stdout).toMatch(/documenso: 1 tables, every one with the same number of rows as before\./);
    expect(r.stdout).toContain("Making the first backup with Postgres 18");
    expect(s.volumeHash(s.oldVolume)).toBe(before);

    expect(s.startNew().status).toBe(0);
    await s.ready();
    expect(Number(s.sql("show server_version_num", "postgres").stdout.trim())).toBeGreaterThanOrEqual(180000);
    expect(s.sql("select string_agg(datname || ':' || pg_get_userbyid(datdba), ',' order by datname) from pg_database where not datistemplate", "postgres").stdout.trim())
      .toBe("booster:booster,documenso:documenso,postgres:postgres");
    expect(login("booster", PASSWORDS.PORTAL_DB_PASSWORD, "booster", "select count(*) || '|' || pg_get_userbyid(c.relowner) from family_note, pg_class c where c.relname = 'family_note' group by c.relowner").stdout.trim()).toBe("120|booster");
    expect(login("documenso", PASSWORDS.DOCUMENSO_DB_PASSWORD, "documenso", `select count(*) from "Envelope"`).stdout.trim()).toBe("30");
    expect(login("documenso", PASSWORDS.DOCUMENSO_DB_PASSWORD, "booster", "select 1").status).not.toBe(0);

    const first = readdirSync(backups);
    expect(first.filter((f) => /^booster-rocket-\d{8}T\d{6}Z\.dump$/.test(f))).toHaveLength(1);
    expect(first.filter((f) => /^documenso-\d{8}T\d{6}Z\.dump$/.test(f))).toHaveLength(1);
    const file = path.join(backups, first.find((f) => f.startsWith("booster-rocket-"))!);
    const listed = spawnSync("docker", ["exec", "-i", s.db, "pg_restore", "--list"], { input: readFileSync(file), encoding: "utf8" });
    expect(listed.stdout).toMatch(/Dumped by pg_dump version: 18\./);
  });

  it("goes back to Postgres 16 on the old data, which says a Postgres 18 backup is newer, not damaged", async () => {
    expect(s.compose("new", ["stop"]).status).toBe(0);
    expect(s.run("bash", [path.join(s.dir, "scripts/move-postgres.sh"), "deploy", "--stop"]).status).toBe(0);
    await s.startOld();
    expect(Number(s.sql("show server_version_num", "postgres").stdout.trim())).toBeLessThan(170000);
    expect(s.sql("select count(*) from family_note").stdout.trim()).toBe("120");
    expect(s.sql("select count(*) from pg_database where datname = 'booster_restore_check'", "postgres").stdout.trim()).toBe("1");

    const file = path.join(backups, readdirSync(backups).find((f) => f.startsWith("booster-rocket-"))!);
    expect(existsSync(file)).toBe(true);
    const r = spawnSync("bash", [path.join(s.dir, "scripts/restore.sh"), file, "booster_back"],
      { cwd: s.dir, encoding: "utf8", env: { ...process.env, BR_DB_CONTAINER: s.db, BR_DB_USER: "postgres" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("was made by a newer version of Postgres than this server's (16.");
    expect(r.stderr).toContain("The file itself is not damaged");
    expect(r.stderr).not.toContain("or it is damaged");
    expect(s.sql("select count(*) from pg_database where datname like 'booster_back%'", "postgres").stdout.trim()).toBe("0");
  });
});
