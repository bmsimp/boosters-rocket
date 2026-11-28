import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The proof of concept runs the backup service as deploy/compose.yml does, so Settings, Backups works there too: the
 * agent (scripts/backup-agent.sh) in Postgres's own image, the checkout's scripts read only, the backups folder
 * deploy.sh backs up into, and the outbox shared with the app. The agent itself is run for real by
 * tests/integration/backup-agent.test.ts.
 */
const poc = readFileSync("docker-compose.poc.yml", "utf8");
const deploy = readFileSync("deploy/compose.yml", "utf8");

/** One service's block of a compose file: from its name to the next service or top-level key. */
function service(compose: string, name: string): string {
  const at = compose.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  if (at < 0) throw new Error(`no service ${name}`);
  const rest = compose.slice(at + 1);
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$|^\S/m);
  return compose.slice(at, next < 0 ? undefined : at + 1 + next);
}
const imageOf = (block: string) => /^\s+image:\s*(\S+)/m.exec(block)?.[1] ?? "";

describe("the proof of concept's backup service", () => {
  const backup = service(poc, "backup");

  it("runs the agent, in the database's own image, with the checkout's scripts read only", () => {
    expect(imageOf(backup)).toBe(imageOf(service(poc, "db")));
    expect(backup).toContain('entrypoint: ["bash", "/opt/booster-rocket/scripts/backup-agent.sh", "/backups"]');
    expect(backup).toContain("- ./scripts:/opt/booster-rocket/scripts:ro");
    expect(backup).toContain("restart: unless-stopped");
    expect(backup).toContain("container_name: booster-rocket-backup");
  });

  it("reaches the database over the network as its administrator, never through a Docker socket", () => {
    expect(backup).toContain('BR_DB_CONTAINER: ""');
    expect(backup).toContain("PGHOST: db");
    expect(backup).toContain("PGUSER: booster");
    expect(backup).toContain("PGPASSWORD: ${DB_PASSWORD:?DB_PASSWORD is required}");
    expect(backup).not.toContain("docker.sock");
    expect(backup).toContain("networks: [internal]");
    expect(backup).not.toContain("ports:");
  });

  it("writes into the folder deploy.sh backs up into", () => {
    expect(backup).toContain("- ${BR_BACKUP_DIR:-${HOME}/booster-rocket-backups}:/backups");
    const script = readFileSync("scripts/poc/deploy.sh", "utf8");
    expect(script).toContain('BR_BACKUP_DIR="${BR_BACKUP_DIR:-$HOME/booster-rocket-backups}"');
    expect(script).toMatch(/^export BR_BACKUP_DIR$/m);
  });

  it("shares the outbox with the app alone, given to the app's user, as deploy/compose.yml does", () => {
    expect(backup).toContain("- backup-outbox:/backup-outbox");
    expect(backup).toContain("BR_OUTBOX: /backup-outbox");
    expect(backup).toContain('BR_OUTBOX_OWNER: "1000:1000"');
    const app = service(poc, "app");
    expect(app).toContain("BACKUP_OUTBOX: /backup-outbox");
    expect(app).toContain("- backup-outbox:/backup-outbox");
    for (const other of ["worker", "migrate", "db"]) expect(service(poc, other), other).not.toContain("backup-outbox");
    expect(poc).toMatch(/^ {2}backup-outbox:\n {4}name: booster-rocket-backup-outbox$/m);
    // The same settings as a club's installation, where they matter to the agent.
    for (const line of ["BR_BACKUP_AT: ${BACKUP_AT:-03:00}", "BR_BACKUP_KEEP: ${BACKUP_KEEP:-14}", "stop_grace_period: 2m"]) {
      expect(service(deploy, "backup"), line).toContain(line);
      expect(backup, line).toContain(line);
    }
  });
});
