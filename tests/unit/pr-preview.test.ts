import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { DEFAULT_E2E_MAIL_PORT } from "../e2e/run-config";
import { staffSessionCookie } from "../e2e/staff-session";
import { parentSessionCookie, PARENT_SESSION_TOKEN } from "../e2e/parent-session";

/**
 * Pull request previews (docs/superpowers/specs/2026-11-27-pr-previews-design.md): each pull request's branch on test
 * data, beside the site on the same machine. What keeps them off the real world is written into
 * docker-compose.preview.yml, docker-compose.preview-edge.yml and scripts/poc/preview.sh, and this holds it there: no
 * service running a branch's code on a network with a way out, no published port, nothing named like the site's, mail
 * only to the preview's own mailbox, no fork's code, and a door whose cookies are the ones the e2e run makes.
 */
const read = (file: string) => readFileSync(path.resolve(file), "utf8");
const compose = read("docker-compose.preview.yml");
const edgeCompose = read("docker-compose.preview-edge.yml");
const script = read("scripts/poc/preview.sh");

/** One block of a compose file at an indent: from its name to the next key at that indent or less. */
function block(text: string, name: string, indent = 2): string {
  const at = text.search(new RegExp(`^ {${indent}}${name}:\\s*$`, "m"));
  if (at < 0) throw new Error(`no block ${name}`);
  const body = text.indexOf("\n", at) + 1;
  const next = text.slice(body).search(new RegExp(`^ {0,${indent}}[A-Za-z]`, "m"));
  return text.slice(at, next < 0 ? undefined : body + next);
}
const top = (name: string) => block(compose, name, 0);
const service = (name: string) => block(top("services"), name, 2);
const SERVICES = [...top("services").matchAll(/^ {2}([a-z-]+):\s*$/gm)].map((m) => m[1]!);
const networksOf = (s: string) => /^\s+networks:\s*\[([^\]]*)\]/m.exec(service(s))?.[1]?.split(",").map((n) => n.trim()) ?? [];
const proxy = () => block(block(edgeCompose, "services", 0), "proxy", 2);

describe("the previews' compose files", () => {
  it("have the services the design names", () => {
    expect(SERVICES.sort()).toEqual(["app", "db", "door", "mailpit", "seed", "seed-install", "worker"]);
    expect([...block(edgeCompose, "services", 0).matchAll(/^ {2}([a-z-]+):\s*$/gm)].map((m) => m[1])).toEqual(["proxy"]);
  });

  it("put every service that runs the branch's code only on its own preview's internal network", () => {
    expect(block(top("networks"), "internal", 2)).toMatch(/name: booster-rocket-pr-\$\{PREVIEW_PR\}-internal\s+internal: true/);
    for (const s of ["db", "app", "worker", "door", "seed"]) expect(networksOf(s), s).toEqual(["internal"]);
    expect(service("mailpit")).toMatch(/network_mode: "service:app"/);
    // The one service with a way out installs packages and reaches no database.
    expect(networksOf("seed-install")).toEqual(["outside"]);
    expect(service("seed-install")).not.toMatch(/DATABASE_URL|SECRET|_KEY|PASSWORD/);
    // The proxy runs no branch's code: the edge network alone, made internal, joined to a preview only while it runs.
    expect(proxy()).toMatch(/networks: \[edge\]/);
    expect(proxy()).toMatch(/image: caddy:[^\n]+@sha256:/);
    expect(script).toContain('docker network create --internal "$EDGE_NETWORK"');
    expect(script).toMatch(/\{\{\.Internal\}\}[^\n]*"\$EDGE_NETWORK"[\s\S]*?= "true"/);
  });

  it("publish no port on the host", () => {
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(edgeCompose).not.toMatch(/^\s+ports:/m);
  });

  it("name nothing of the site's, and name everything of a preview's own after it", () => {
    for (const text of [compose, edgeCompose, script]) {
      expect(text).not.toMatch(/booster-rocket-(postgres|pgdata|internal|edge|app|worker|db-1)\b(?!-)/);
      expect(text).not.toMatch(/--env-file[^\n]*\.env\.poc/);
    }
    for (const m of compose.matchAll(/^\s+(?:name|container_name): (\S+)$/gm)) {
      expect(m[1]!, m[1]).toMatch(/^booster-rocket-(pr-\$\{PREVIEW_PR\}-|preview-pnpm-store$)/);
    }
    // It removes only one preview's own things, by name, and never prunes.
    expect([...script.matchAll(/docker volume rm (\S+)/g)].map((m) => m[1]).sort())
      .toEqual(['"booster-rocket-pr-$PREVIEW_PR-db"', '"booster-rocket-pr-$PREVIEW_PR-node-modules"']);
    expect(script).not.toMatch(/docker[^\n]*\bprune\b/);
  });

  it("seed a test database, which the seed alone empties", () => {
    expect(service("db")).toMatch(/POSTGRES_DB: booster_preview_test/);
    expect(service("seed")).toMatch(/DATABASE_URL: postgresql:\/\/booster:\$\{DB_PASSWORD\}@db:5432\/booster_preview_test/);
    expect(service("seed")).toMatch(/scripts\/seed-e2e\.ts/);
  });

  it("send mail only to the preview's mailbox, where the seed's mail settings point, and the mailbox relays nothing", () => {
    expect(read("scripts/seed-e2e.ts")).toMatch(/method: "smtp", host: "127\.0\.0\.1", port: mailPort, security: "tls"/);
    expect(service("mailpit")).toContain(`MP_SMTP_BIND_ADDR: 127.0.0.1:${DEFAULT_E2E_MAIL_PORT}`);
    expect(service("mailpit")).toMatch(/MP_SMTP_REQUIRE_TLS: "true"/);
    expect(service("mailpit")).not.toMatch(/RELAY/);
    expect(service("seed")).not.toMatch(/E2E_MAIL_PORT/);
    expect(service("app")).toMatch(/NODE_EXTRA_CA_CERTS: \/preview\/mail-cert\.pem/);
    expect(service("app")).toMatch(/QBO_RELAY_URL: http:\/\/127\.0\.0\.1:9/);
  });

  it("cap every long-running service's memory and CPU", () => {
    for (const s of ["db", "app", "mailpit", "worker", "door"]) {
      expect(service(s), s).toMatch(/mem_limit: \d+m/);
      expect(service(s), s).toMatch(/cpus: [\d.]+/);
    }
    expect(proxy()).toMatch(/mem_limit: \d+m/);
  });

  it("answer only what came through the access gate, at a host of the one shape", () => {
    const caddy = read("scripts/poc/preview/Caddyfile");
    expect(caddy).toMatch(/@gated header_regexp gate \{\$PREVIEW_GATE_HEADER\} \.\+/);
    expect(caddy).toContain("header_regexp pr Host ^pr-([1-9][0-9]{0,5})\\.{$PREVIEW_DOMAIN}$");
    // Every upstream is named by the host's number alone.
    const upstreams = [...caddy.matchAll(/reverse_proxy (\S+)/g)].map((m) => m[1]!);
    expect(upstreams.length).toBe(3);
    for (const u of upstreams) expect(u).toMatch(/^booster-rocket-pr-\{re\.pr\.1\}-(app|door):\d+$/);
    expect(caddy).toMatch(/handle \{\s+respond "This preview is private\." 403\s+\}/);
  });
});

describe("preview.sh", { timeout: 30_000 }, () => {
  const slash = (p: string) => p.replace(/\\/g, "/");
  const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  let dir: string, home: string, bin: string, log: string, pulls: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "br-preview-"));
    home = path.join(dir, "preview-home");
    bin = path.join(dir, "bin"); mkdirSync(bin);
    log = path.join(dir, "calls.log");
    pulls = path.join(dir, "pull.json");
    mkdirSync(path.join(dir, "scripts", "poc"), { recursive: true });
    copyFileSync(path.resolve("scripts/poc/preview.sh"), path.join(dir, "scripts/poc/preview.sh"));
    writeFileSync(path.join(dir, ".env.poc"), "APP_URL=https://portal.example.org\nBETTER_AUTH_SECRET=site-secret-site-secret-site-secret-00\nDB_PASSWORD=site-db\nSETTINGS_ENCRYPTION_KEY=site-key\n");
    spawnSync("git", ["init", "-q", dir]);
    spawnSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/club/portal.git"]);
    const fake = (name: string, body: string) => {
      writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${slash(log)}"\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    // The edge network is there only once init makes it, and then answers "true" to --format, as an internal one would.
    fake("docker", `if [ "$1 $2" = "network inspect" ]; then [ "$3" = "--format" ] && { echo true; exit 0; }; exit 1; fi\nexit 0`);
    // GitHub answers with whatever pull.json holds.
    fake("curl", `cat "${slash(pulls)}"`);
    // Cloning and fetching do nothing (and are logged); anything else is git itself.
    fake("git", `case " $* " in *" clone "*) mkdir -p "\${@: -1}/.git"; exit 0;; *" fetch "*) exit 0;; esac\nexec "${slash(realGit)}" "$@"`);
  });
  const run = (...args: string[]) => spawnSync("bash", [path.join(dir, "scripts/poc/preview.sh"), ...args], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BR_DIR: dir, BR_PREVIEW_HOME: home },
  });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const envFile = () => path.join(home, ".env.preview");
  const pull = (head: string) => writeFileSync(pulls, JSON.stringify({
    state: "open",
    base: { repo: { full_name: "club/portal" } },
    head: { repo: head ? { full_name: head } : null, ref: "feature/x", sha: "a".repeat(40) },
  }));
  const init = () => expect(run("init", "previews.example.net", "Cf-Access-Jwt-Assertion", "owner-login").status).toBe(0);

  it("init writes the shared settings, names the repository from the checkout, and changes nothing of the site's", () => {
    init();
    const env = readFileSync(envFile(), "utf8").split("\n");
    for (const line of ["PREVIEW_DOMAIN=previews.example.net", "PREVIEW_GATE_HEADER=Cf-Access-Jwt-Assertion", "PREVIEW_REPO=club/portal", "PREVIEW_OWNER=owner-login", "PREVIEW_MAX=2"]) {
      expect(env).toContain(line);
    }
    expect(calls()).toContain("docker network create --internal booster-rocket-preview-edge");
    expect(read(path.join(dir, ".env.poc"))).toContain("DB_PASSWORD=site-db");
  });

  it("init refuses the site's own domain, a missing argument, or a domain that isn't one", () => {
    for (const args of [["example.org", "X-Gate", "o"], ["previews.example.net", "X-Gate"], ["https://previews.example.net", "X-Gate", "o"], ["previews", "X-Gate", "o"]]) {
      const r = run("init", ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(existsSync(envFile()), args.join(" ")).toBe(false);
    }
    expect(calls()).not.toContain("network create");
  });

  // jq reads GitHub's answers; every Linux runner has it, a Windows desktop may not.
  const hasJq = spawnSync("bash", ["-c", "command -v jq"]).status === 0;
  it.skipIf(!hasJq)("refuses a fork's pull request, or one whose fork is gone, before it fetches or builds anything", () => {
    init();
    for (const head of ["someone/portal", ""]) {
      pull(head);
      const r = run("up", "12");
      expect(r.status, head).toBe(2);
      expect(r.stderr, head).toContain("comes from a fork");
    }
    expect(calls()).not.toMatch(/git [^\n]*fetch|compose .*build|volume rm/);
  });

  it("fetches the branch itself, never the pull request's ref a fork writes", () => {
    expect(script).toContain('"+refs/heads/$PR_BRANCH:refs/preview/pr-$PREVIEW_PR"');
    expect(script).not.toMatch(/refs\/pull\//);
  });

  it("takes a pull request's number and nothing else", () => {
    init();
    pull("club/portal");
    for (const bad of ["", "0", "-1", "12a", "../1", "1234567", "main"]) {
      expect(run("up", bad).status, bad).toBe(2);
    }
    expect(calls()).not.toMatch(/curl|compose .*build/);
  });
});

describe("the preview door", () => {
  let door: ChildProcess | undefined;
  afterEach(() => { door?.kill(); door = undefined; });

  const freePort = () => new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });

  it("sets the very cookies the e2e run makes for the seed's two sessions, and nothing for any other path", async () => {
    const secret = "door-test-secret-door-test-secret-0000";
    const port = await freePort();
    door = spawn(process.execPath, [path.resolve("scripts/poc/preview/door.mjs")], {
      env: { ...process.env, BETTER_AUTH_SECRET: secret, APP_URL: "https://preview.example.org", PREVIEW_DOOR_PORT: String(port), PREVIEW_REF: "<b>x</b>" },
    });
    await new Promise<void>((resolve) => door!.stdout!.once("data", () => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const previous = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = secret;
    const staff = staffSessionCookie(), parent = parentSessionCookie();
    process.env.BETTER_AUTH_SECRET = previous;

    const staffRes = await fetch(`${base}/__preview/staff`, { method: "POST", redirect: "manual" });
    expect(staffRes.status).toBe(303);
    expect(staffRes.headers.get("location")).toBe("/staff");
    expect(staffRes.headers.get("set-cookie")).toMatch(new RegExp(`^__Secure-${staff.name}=${staff.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; Path=/; HttpOnly; SameSite=Lax; .*Secure$`));

    const parentRes = await fetch(`${base}/__preview/parent`, { method: "POST", redirect: "manual" });
    expect(parentRes.headers.get("set-cookie")).toContain(`__Secure-${parent.name}=${parent.value};`);
    expect(read("scripts/seed-e2e.ts")).toContain(`'${PARENT_SESSION_TOKEN}'`);

    const pageRes = await fetch(`${base}/__preview/`);
    const html = await pageRes.text();
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");

    for (const [method, p] of [["GET", "/__preview/staff"], ["POST", "/__preview/toString"], ["POST", "/__preview/constructor"], ["GET", "/"]] as const) {
      const res = await fetch(`${base}${p}`, { method, redirect: "manual" });
      expect(res.status, `${method} ${p}`).toBe(404);
      expect(res.headers.get("set-cookie"), `${method} ${p}`).toBeNull();
    }
  });
});
