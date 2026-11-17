import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

/**
 * The move from Postgres 16 to Postgres 18 (scripts/move-postgres.sh, scripts/postgres-guard.sh), run for real with
 * docker compose on a copy of the development compose file, in a compose project of its own: data written by Postgres
 * 16 in the old layout is never met by an empty Postgres 18 (the start is refused, with what to do, and nothing in the
 * old volume changes); the move carries every row across; a second run changes nothing; going back to 16 still works
 * and a later start of 18 is refused until the move is run again; and a move cut off half way leaves a start that is
 * refused, until it is run again. deploy/compose.yml and docker-compose.poc.yml use the same guard and script
 * (docs/runbooks/updates.md, docs/runbooks/poc-linuxdev.md): each was rehearsed by hand in the same way.
 */
const root = path.resolve(__dirname, "../..");
const OLD_IMAGE = /^OLD_IMAGE="(postgres:16[^"]+)"$/m.exec(readFileSync(path.join(root, "scripts/move-postgres.sh"), "utf8"))![1]!;
const NEW_IMAGE = /^\s+image:\s*(postgres:\S+)/m.exec(readFileSync(path.join(root, "docker-compose.yml"), "utf8"))![1]!;
const PROJECT = `br-move-${process.pid}-${randomBytes(3).toString("hex")}`;
const DB = `${PROJECT}-db-1`;
const OLD_VOLUME = `${PROJECT}_pgdata`;
const NEW_VOLUME = `${PROJECT}_postgres-data`;
let dir: string, moveDir: string;

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

const run = (cmd: string, args: string[], timeout = 240_000) =>
  spawnSync(cmd, args, { cwd: dir, encoding: "utf8", timeout, env: { ...process.env, COMPOSE_PROJECT_NAME: PROJECT } });
const docker = (args: string[], timeout?: number) => run("docker", args, timeout);
const compose = (file: "old" | "new", args: string[]) => docker(["compose", "-p", PROJECT, "-f", file === "old" ? "old-compose.yml" : "docker-compose.yml", ...args]);
const move = (...args: string[]) => run("bash", [path.join(dir, "scripts/move-postgres.sh"), "dev", moveDir, ...args], 400_000);
const sql = (query: string) => docker(["exec", DB, "psql", "-U", "booster", "-d", "booster", "-Atqc", query]);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, seconds = 180) {
  for (let i = 0; i < seconds * 2; i++) { if (ok()) return; await pause(500); }
  throw new Error(`gave up waiting: ${what}`);
}
const ready = () => until("Postgres to answer", () => docker(["exec", DB, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "booster", "-d", "booster"]).status === 0);
const state = () => docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", DB]).stdout.trim();
const refused = async () => { await until("the database container to stop", () => state().startsWith("exited")); return state(); };
/** Every file in a volume, by name and content: whether anything at all changed in it. */
const volumeHash = (volume: string) => docker(["run", "--rm", "--network", "none", "-v", `${volume}:/d:ro`, "--entrypoint", "bash", NEW_IMAGE, "-c",
  "cd /d && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum"]).stdout.trim();
const startOld = async () => { expect(compose("old", ["up", "-d", "--force-recreate", "db"]).status).toBe(0); await ready(); };
const startNew = () => compose("new", ["up", "-d", "--force-recreate", "db"]);

describe("moving the database from Postgres 16 to Postgres 18", { timeout: 600_000 }, () => {
  beforeAll(() => {
    for (const image of [OLD_IMAGE, NEW_IMAGE]) {
      const there = docker(["image", "inspect", image]).status === 0 || docker(["pull", "-q", image], 280_000).status === 0;
      expect(there, `docker can't run ${image}`).toBe(true);
    }
    dir = mkdtempSync(path.join(tmpdir(), "br-move-"));
    moveDir = path.join(dir, "moving");
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "docker/initdb"), { recursive: true });
    for (const f of ["move-postgres.sh", "postgres-guard.sh", "backup.sh", "restore.sh"]) copyFileSync(path.join(root, "scripts", f), path.join(dir, "scripts", f));
    copyFileSync(path.join(root, "docker/initdb/01-test-db.sql"), path.join(dir, "docker/initdb/01-test-db.sql"));
    // The same file, with no fixed port: tests run beside each other and beside the developer's own database.
    const current = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
    expect(current).toMatch(/^\s+ports: .*$/m);
    writeFileSync(path.join(dir, "docker-compose.yml"), current.replace(/^\s+ports: .*\n/m, ""));
    writeFileSync(path.join(dir, "old-compose.yml"), OLD_COMPOSE);
  }, 300_000);

  afterAll(() => {
    if (!dir) return;
    for (const c of ["move-probe", "move-postgres-16", "move-postgres-18"]) docker(["rm", "-f", `${PROJECT}-${c}`]);
    compose("new", ["down", "-v", "--remove-orphans"]);
    compose("old", ["down", "-v", "--remove-orphans"]);
    docker(["volume", "rm", OLD_VOLUME, NEW_VOLUME]);
    rmSync(dir, { recursive: true, force: true });
  }, 300_000);

  it("refuses to start Postgres 18 beside data Postgres 16 left, says what to do, and changes nothing", async () => {
    await startOld();
    expect(sql("create table family_note (id serial primary key, body text not null); insert into family_note (body) select 'note ' || g from generate_series(1, 250) g").status).toBe(0);
    expect(compose("old", ["stop"]).status).toBe(0);
    const before = volumeHash(OLD_VOLUME);

    startNew();
    expect(await refused()).toBe("exited 2");
    const logs = compose("new", ["logs", "db"]).stdout;
    expect(logs).toContain("Postgres was NOT started, and no data was changed or deleted.");
    expect(logs).toContain("Starting here would make a new, empty database");
    expect(logs).toContain('What to do: AGENTS.md, Tests, "Moving the local database to Postgres 18"');
    expect(compose("new", ["run", "--rm", "--no-deps", "-T", "db", "check"]).status).toBe(2);
    expect(volumeHash(OLD_VOLUME)).toBe(before);
    expect(compose("new", ["run", "--rm", "--no-deps", "-T", "db", "state"]).stdout).toMatch(/^old=yes new=empty same=- fingerprint=[0-9a-f]{64}$/m);
  });

  it("moves every row to Postgres 18, and leaves the old data where it was", async () => {
    const r = move();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("every one with the same number of rows as before");
    expect(r.stdout).toContain("The move is done");
    expect(startNew().status).toBe(0);
    await ready();
    expect(Number(sql("show server_version_num").stdout.trim())).toBeGreaterThanOrEqual(180000);
    expect(sql("select count(*), max(body) from family_note").stdout.trim()).toBe("250|note 99");
    expect(docker(["run", "--rm", "--network", "none", "-v", `${OLD_VOLUME}:/d:ro`, "--entrypoint", "cat", NEW_IMAGE, "/d/PG_VERSION"]).stdout.trim()).toBe("16");
  });

  it("run a second time, changes nothing and leaves Postgres 18 running", () => {
    const r = move();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("already moved to Postgres 18");
    expect(state()).toBe("running 0");
  });

  it("can go back to 16 on the old data; 18 is then refused until the move is run again with --again", async () => {
    expect(compose("new", ["stop"]).status).toBe(0);
    await startOld();
    expect(Number(sql("show server_version_num").stdout.trim())).toBeLessThan(170000);
    expect(sql("select count(*) from family_note").stdout.trim()).toBe("250");
    expect(sql("insert into family_note (body) values ('written on 16 after going back')").status).toBe(0);
    expect(compose("old", ["stop"]).status).toBe(0);

    startNew();
    expect(await refused()).toBe("exited 2");
    expect(compose("new", ["logs", "--tail", "12", "db"]).stdout).toContain("Postgres 16 has been started on the old data since");
    const without = move();
    expect(without.status).toBe(2);
    expect(without.stderr).toContain("--again");
    const again = move("--again");
    expect(again.status, again.stderr).toBe(0);
    expect(startNew().status).toBe(0);
    await ready();
    expect(sql("select count(*) from family_note where body = 'written on 16 after going back'").stdout.trim()).toBe("1");
  });

  it("cut off half way, leaves a start that is refused; run again, it finishes", async () => {
    expect(compose("new", ["stop"]).status).toBe(0);
    await startOld();
    expect(sql("insert into family_note (body) values ('written before the cut-off move')").status).toBe(0);
    expect(compose("old", ["stop"]).status).toBe(0);

    const child = spawn("bash", [path.join(dir, "scripts/move-postgres.sh"), "dev", moveDir, "--again"], { cwd: dir, env: { ...process.env, COMPOSE_PROJECT_NAME: PROJECT } });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", () => {});
    const exited = new Promise((r) => child.on("exit", r));
    await until("the move to start Postgres 18", () => out.includes("Starting Postgres 18"), 300);
    child.kill("SIGKILL");
    await exited;

    startNew();
    expect(await refused()).toBe("exited 2");
    expect(compose("new", ["logs", "--tail", "12", "db"]).stdout).toContain("was started and did not finish");
    const r = move();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("didn't finish: starting again from the Postgres 16 data");
    expect(startNew().status).toBe(0);
    await ready();
    expect(sql("select count(*) from family_note").stdout.trim()).toBe("252");
  });
});
