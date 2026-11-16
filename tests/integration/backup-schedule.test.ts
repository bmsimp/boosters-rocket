import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The nightly backup's scheduler (scripts/backup-schedule.sh), run where deploy/compose.yml runs it: in the Postgres
 * image the compose file pins, with that image's own date and time-zone data. It works out the next run in the club's
 * zone, refuses settings it can't use, passes backup.sh's exit code on with --now, and in its loop runs backup.sh at
 * the set minute and keeps going after a failure, printing nothing but backup.sh's own lines.
 */
const root = path.resolve(__dirname, "../..");
const IMAGE = /^\s+image:\s*(postgres:\S+)/m.exec(readFileSync(path.join(root, "deploy/compose.yml"), "utf8"))![1]!;
const SCRIPTS = path.join(root, "scripts");
const docker = (args: string[], timeout = 120_000) => spawnSync("docker", args, { encoding: "utf8", timeout });
/** The scheduler in a throwaway container. The database it is pointed at doesn't exist: nothing here needs one. */
const schedule = (args: string[], env: Record<string, string>) => docker(["run", "--rm", "-v", `${SCRIPTS}:/s:ro`,
  ...Object.entries({ BR_DB_CONTAINER: "", PGHOST: "127.0.0.1", PGPORT: "1", BR_DB_WAIT: "1", ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  IMAGE, "bash", "/s/backup-schedule.sh", ...args]);
const nextAt = (out: string) => Date.parse(/, (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\)\.$/m.exec(out)?.[1] ?? "");

describe("the nightly backup's schedule", { timeout: 300_000 }, () => {
  beforeAll(() => {
    const pulled = docker(["image", "inspect", IMAGE]).status === 0 || docker(["pull", "-q", IMAGE], 280_000).status === 0;
    expect(pulled, `docker can't run ${IMAGE}`).toBe(true);
  }, 300_000);

  it("says the next run is the set time of day in the club's zone, within a day", () => {
    const now = Date.now();
    for (const [zone, offsetHours] of [["Pacific/Kiritimati", 14], ["Pacific/Pago_Pago", -11], ["UTC", 0]] as const) {
      const r = schedule(["/backups", "--next"], { TZ: zone, BR_BACKUP_AT: "03:30" });
      expect(r.status, r.stderr).toBe(0);
      const at = nextAt(r.stdout);
      expect(r.stdout).toContain(`(${zone}, `);
      expect(at).toBeGreaterThan(now);
      expect(at - now).toBeLessThanOrEqual(24 * 3_600_000 + 120_000);
      // 03:30 there is 03:30 minus the zone's offset in UTC.
      const local = new Date(at + offsetHours * 3_600_000);
      expect([local.getUTCHours(), local.getUTCMinutes()], zone).toEqual([3, 30]);
    }
  });

  it("refuses a time, a zone or arguments it can't use, as backup.sh refuses (2)", () => {
    for (const [args, env, says] of [
      [["/backups"], { TZ: "UTC", BR_BACKUP_AT: "3am" }, "BR_BACKUP_AT must be a time of day"],
      [["/backups"], { TZ: "UTC", BR_BACKUP_AT: "24:00" }, "BR_BACKUP_AT must be a time of day"],
      [["/backups"], { TZ: "Nowhere/Land" }, "isn't a time zone this machine knows"],
      [["/backups"], { TZ: "../../etc/passwd" }, "isn't a time zone this machine knows"],
      [["/backups"], { TZ: "" }, "Set TZ to the club's time zone"],
      [[], { TZ: "UTC" }, "Usage:"],
      [["/backups", "--keep", "0"], { TZ: "UTC" }, "--keep takes a number"],
      [["/backups", "--what"], { TZ: "UTC" }, "Usage:"],
    ] as const) {
      const r = schedule([...args], env);
      expect(r.status, `${args.join(" ")} ${JSON.stringify(env)}`).toBe(2);
      expect(r.stderr).toContain(says);
    }
  });

  it("with --now runs one backup and exits with backup.sh's own code", () => {
    const r = schedule(["/backups", "--now"], { TZ: "UTC" });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("didn't answer within 1s. Nothing was backed up.");
  });

  it("with the schedule off, says so and runs nothing", () => {
    const r = schedule(["/backups", "--next"], { TZ: "UTC", BR_BACKUP_AT: "off" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nightly backups are off here");
  });

  describe("left running", () => {
    const name = `br-schedule-${process.pid}-${randomBytes(3).toString("hex")}`;
    afterAll(() => { docker(["rm", "-f", name]); });

    it("runs backup.sh at the set minute, keeps going after it fails, prints only its lines, and stops at once when told", async () => {
      // The first whole minute at least 20 seconds away, in UTC: the container is started well before it.
      const target = new Date(Math.ceil((Date.now() + 20_000) / 60_000) * 60_000);
      const at = `${String(target.getUTCHours()).padStart(2, "0")}:${String(target.getUTCMinutes()).padStart(2, "0")}`;
      const started = docker(["run", "-d", "--name", name, "-v", `${SCRIPTS}:/s:ro`, "-e", "TZ=UTC", "-e", `BR_BACKUP_AT=${at}`, "-e", "BR_DB_CONTAINER=",
        "-e", "PGHOST=127.0.0.1", "-e", "PGPORT=1", "-e", "BR_DB_WAIT=1", IMAGE, "bash", "/s/backup-schedule.sh", "/backups"]);
      expect(started.status, started.stderr).toBe(0);
      const logs = () => { const r = docker(["logs", name]); return r.stdout + r.stderr; };
      const deadline = target.getTime() + 60_000;
      while (!logs().includes("Nothing was backed up.") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
      const out = logs();
      expect(out.trim()).toBe("The database booster didn't answer within 1s. Nothing was backed up.");
      expect(Date.now()).toBeGreaterThanOrEqual(target.getTime());
      expect(docker(["inspect", "-f", "{{.State.Running}}", name]).stdout.trim()).toBe("true");
      const before = Date.now();
      expect(docker(["stop", "-t", "30", name]).status).toBe(0);
      expect(Date.now() - before).toBeLessThan(15_000);
      expect(docker(["inspect", "-f", "{{.State.ExitCode}}", name]).stdout.trim()).toBe("0");
    }, 200_000);
  });
});
