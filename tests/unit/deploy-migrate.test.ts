import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * deploy/'s migrate step checks for a recent backup before it changes a database that holds data
 * (scripts/backup-check.mjs, proved against a database in tests/integration/migrate-script.test.ts). The proof of
 * concept's compose file backs up first in scripts/poc/deploy.sh and runs the migrator as it always has.
 */
const deploy = readFileSync("deploy/compose.yml", "utf8");
const poc = readFileSync("docker-compose.poc.yml", "utf8");
const dockerfile = readFileSync("Dockerfile", "utf8");
const service = (compose: string, name: string) => {
  const start = compose.indexOf(`\n  ${name}:`);
  const next = compose.slice(start + 1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  return compose.slice(start, next < 0 ? undefined : start + 1 + next);
};

describe("the migrate step's backup check", () => {
  it("is in the image beside the migrator", () => {
    expect(dockerfile).toMatch(/COPY scripts\/migrate\.mjs scripts\/backup-check\.mjs [^\n]* \.\/scripts\//);
  });
  it("runs in deploy/'s migrate service, with the one-start override passed through and empty unless given", () => {
    const migrate = service(deploy, "migrate");
    expect(migrate).toContain('command: ["node", "tools/scripts/migrate.mjs", "--backup-check"]');
    expect(migrate).toContain("MIGRATE_WITHOUT_RECENT_BACKUP: ${MIGRATE_WITHOUT_RECENT_BACKUP:-}");
  });
  it("leaves the proof of concept's migrate as it was: its deploy script backs up first", () => {
    expect(service(poc, "migrate")).toContain('command: ["node", "tools/scripts/migrate.mjs"]');
    expect(poc).not.toContain("--backup-check");
  });
  it("is in the updates runbook and the first installation's, with the override and when to use it", () => {
    const updates = readFileSync("docs/runbooks/updates.md", "utf8"), first = readFileSync("docs/runbooks/first-install.md", "utf8");
    expect(updates).toContain("## When the start stops for a backup");
    expect(updates).toContain("docker compose run --rm backup --now");
    expect(updates).toContain("MIGRATE_WITHOUT_RECENT_BACKUP=yes docker compose up -d");
    expect(updates).toContain("Never put `MIGRATE_WITHOUT_RECENT_BACKUP` in `.env`");
    expect(first).toContain("updates.md#when-the-start-stops-for-a-backup");
  });
});
