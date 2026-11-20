import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every place that names Postgres names the same major version, and every compose file starts it the one safe way:
 * through scripts/postgres-guard.sh, its data on a volume at /var/lib/postgresql (where the 18 image keeps it, in
 * 18/docker), the volume Postgres 16 left mounted read only at /old-data, and the guard told which runbook section to
 * name. Without the guard, an empty Postgres 18 beside data that was never moved would greet the club with /setup.
 * The move itself is run for real by tests/integration/postgres-move.test.ts.
 */
const read = (file: string) => readFileSync(path.resolve(file), "utf8");
const MAJOR = "18";

/** One service's block of a compose file: from its name to the next service or top-level key. */
function service(compose: string, name: string): string {
  const at = compose.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  if (at < 0) throw new Error(`no service ${name}`);
  const rest = compose.slice(at + 1);
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$|^\S/m);
  return compose.slice(at, next < 0 ? undefined : at + 1 + next);
}
const imageOf = (block: string) => /^\s+image:\s*(\S+)/m.exec(block)?.[1] ?? "";
const headings = (file: string) => [...read(file).matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1]!.trim());

const COMPOSE_FILES = [
  { file: "docker-compose.yml", guard: "./scripts/postgres-guard.sh", runbook: ["AGENTS.md", "Moving the local database to Postgres 18"] },
  { file: "docker-compose.poc.yml", guard: "./scripts/postgres-guard.sh", runbook: ["docs/runbooks/poc-linuxdev.md", "Moving the database to Postgres 18"] },
  { file: "deploy/compose.yml", guard: "../scripts/postgres-guard.sh", runbook: ["docs/runbooks/updates.md", "Moving to a new major version of Postgres"] },
] as const;

describe("Postgres's version", () => {
  it(`is ${MAJOR} in every place that names it`, () => {
    const deploy = read("deploy/compose.yml");
    const named = [
      imageOf(service(read("docker-compose.yml"), "db")),
      imageOf(service(read("docker-compose.poc.yml"), "db")),
      imageOf(service(deploy, "db")),
      imageOf(service(deploy, "backup")),
      /services:\s+postgres:\s+image:\s*(\S+)/.exec(read(".github/workflows/ci.yml"))?.[1] ?? "",
      /services:\s+postgres:\s+image:\s*(\S+)/.exec(read(".github/workflows/focused.yml"))?.[1] ?? "",
      / (postgres:\S+) >\/dev\/null/.exec(read("scripts/smoke-image.sh"))?.[1] ?? "",
    ];
    for (const image of named) expect(image, image).toMatch(new RegExp(`^postgres:${MAJOR}(\\.\\d+)?(@sha256:[0-9a-f]{64})?$`));
    // A club's installation: one exact version and digest, the same for the server and the backups' tools.
    expect(imageOf(service(deploy, "db"))).toMatch(new RegExp(`^postgres:${MAJOR}\\.\\d+@sha256:[0-9a-f]{64}$`));
    expect(imageOf(service(deploy, "backup"))).toBe(imageOf(service(deploy, "db")));
  });

  it("is the 16 the move starts from only in the move itself", () => {
    expect(read("scripts/move-postgres.sh")).toMatch(/^OLD_IMAGE="postgres:16\.\d+@sha256:[0-9a-f]{64}"$/m);
    for (const { file } of COMPOSE_FILES) expect(read(file), file).not.toMatch(/postgres:1[0-7]\b/);
  });

  it("never comes as an ordinary dependency update", () => {
    const blocks = read(".github/dependabot.yml").split(/\n {2}- package-ecosystem: /).slice(1);
    for (const ecosystem of ["docker", "docker-compose", "github-actions"]) {
      const block = blocks.find((b) => b.startsWith(`${ecosystem}\n`))!;
      expect(block, ecosystem).toMatch(/ignore:\n\s+- dependency-name: postgres\n\s+update-types: \["version-update:semver-major"\]/);
      expect(block, ecosystem).toContain("Moving to a new major version of Postgres");
      expect(block, ecosystem).toContain("lead chose this");
    }
  });
});

describe.each(COMPOSE_FILES)("$file starts Postgres only through the guard", ({ file, guard, runbook }) => {
  const db = service(read(file), "db");

  it("runs the guard in front of the image's own entrypoint", () => {
    expect(db).toMatch(/entrypoint: \["bash", "\/opt\/booster-rocket\/postgres-guard\.sh"\]/);
    expect(db).toMatch(/command: \["postgres"\]/);
    expect(db).toContain(`- ${guard}:/opt/booster-rocket/postgres-guard.sh:ro`);
  });

  it("keeps the data at /var/lib/postgresql, and the old volume read only at /old-data, never at the old path", () => {
    const mounts = [...db.matchAll(/^\s+- ([\w.-]+):(\/[\w/.-]+)(:ro)?$/gm)].map((m) => ({ volume: m[1]!, at: m[2]!, ro: Boolean(m[3]) }));
    const data = mounts.filter((m) => m.at === "/var/lib/postgresql");
    const old = mounts.filter((m) => m.at === "/old-data");
    expect(data).toHaveLength(1);
    expect(data[0]!.ro).toBe(false);
    expect(old).toHaveLength(1);
    expect(old[0]!.ro).toBe(true);
    expect(old[0]!.volume).not.toBe(data[0]!.volume);
    expect(db).not.toContain("/var/lib/postgresql/data");
  });

  it("tells the guard a runbook section that exists", () => {
    const named = /BR_MOVE_RUNBOOK: '([^']+)'/.exec(db)?.[1] ?? "";
    expect(named).toContain(runbook[0]);
    expect(named).toContain(runbook[1]);
    const [doc, heading] = runbook;
    if (doc === "AGENTS.md") expect(read(doc)).toContain(`${heading}:`);
    else expect(headings(doc)).toContain(heading);
  });
});

describe("the guard", () => {
  const guard = read("scripts/postgres-guard.sh");

  it("knows the 18 image's data folder from the image, and the old volume by its mount", () => {
    expect(guard).toContain('NEW_ROOT="/var/lib/postgresql"');
    expect(guard).toContain('OLD="/old-data"');
    expect(guard).toMatch(/DATA="\$\{PGDATA:\?/);
  });

  it("writes to the old volume nowhere", () => {
    const lines = guard.split("\n").filter((l) => /\$OLD\b/.test(l));
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(line, line).not.toMatch(/\b(rm|mv|mkdir|chown|chmod|touch|cp|tee|ln)\b[^\n]*\$OLD|>>?\s*"?\$OLD/);
  });
});
