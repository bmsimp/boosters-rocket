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
    expect(caddy).toContain("header_regexp pr Host ^pr-([1-9][0-9]{0,5})-br\\.{$PREVIEW_DOMAIN}$");
    // Only the tunnel connector's network is answered, never a preview's own (the proxy is joined to those too).
    expect(caddy).toMatch(/@preview \{\s+remote_ip \{\$PREVIEW_EDGE_SUBNET\}/);
    // Every upstream is named by the host's number alone.
    const upstreams = [...caddy.matchAll(/reverse_proxy (\S+)/g)].map((m) => m[1]!);
    expect(upstreams.length).toBe(3);
    for (const u of upstreams) expect(u).toMatch(/^booster-rocket-pr-\{re\.pr\.1\}-(app|door):\d+$/);
    expect(caddy).toMatch(/handle \{\s+respond "This preview is private\." 403\s+\}/);
  });
});

// The scripts read JSON with jq: every Linux runner has it, a Windows desktop may not.
const hasJq = spawnSync("bash", ["-c", "command -v jq"]).status === 0;
const slash = (p: string) => p.replace(/\\/g, "/");
const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const DAY = 86_400_000;
// As GitHub writes them: whole seconds.
const iso = (ago: number) => new Date(Date.now() - ago).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Stand-ins for curl and gh, written into a folder put first on PATH. They log every call, answer GitHub from a map of
 * paths (github.json, kept up to date as labels go on and off) and keep a pretend Cloudflare account (cloudflare.json),
 * so each test reads both what was asked and in what order.
 */
function fakes(dir: string) {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(dir, "calls.log"), gh = path.join(dir, "github.json"), cf = path.join(dir, "cloudflare.json");
  writeFileSync(gh, "{}");
  writeFileSync(cf, JSON.stringify({ apps: [], records: [], ghostApps: false, stuckRecords: false }));
  const shim = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${slash(log)}"\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  const node = slash(process.execPath);
  const http = path.join(dir, "fake-http.mjs");
  writeFileSync(http, `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [tool, ...args] = process.argv.slice(2);
const load = (f) => JSON.parse(readFileSync(f, "utf8"));
let method = "GET", body = "", url = "", jq = "", fields = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-X") method = args[++i];
  else if (a === "--data") body = args[++i];
  else if (a === "--jq") jq = args[++i];
  else if (a === "-f") fields.push(args[++i]);
  else if (a === "-H" || a === "--max-time") i++;
  else if (!a.startsWith("-") && a !== "api") url = a;
}
const out = (value) => {
  const text = JSON.stringify(value);
  if (!jq) return process.stdout.write(text);
  const r = spawnSync("jq", ["-r", jq], { input: text, encoding: "utf8" });
  process.stdout.write(r.stdout); process.exit(r.status ?? 1);
};
appendFileSync(${JSON.stringify(log)}, \`http \${method} \${url} \${body}\\n\`);
if (url.includes("/client/v4/")) {
  const s = load(${JSON.stringify(cf)});
  const path = url.split("/client/v4/")[1].split("?")[0];
  const ok = (result) => { writeFileSync(${JSON.stringify(cf)}, JSON.stringify(s)); out({ success: true, result }); };
  const id = path.split("/").pop();
  if (path.endsWith("access/apps")) {
    if (method === "POST") { if (!s.ghostApps) s.apps.push({ id: "app-" + s.apps.length, ...JSON.parse(body) }); ok({}); }
    else ok(s.apps);
  } else if (path.includes("access/apps/")) { s.apps = s.apps.filter((a) => a.id !== id); ok({}); }
  else if (path.endsWith("dns_records")) {
    if (method === "POST") { s.records.push({ id: "rec-" + s.records.length, ...JSON.parse(body) }); ok({}); }
    else if (s.failRecordLookups) out({ success: false, errors: [{ message: "try later" }] });
    else { const name = new URL(url).searchParams.get("name"); ok(s.records.filter((r) => !name || r.name === name)); }
  } else if (path.includes("dns_records/")) { if (!s.stuckRecords) s.records = s.records.filter((r) => r.id !== id); ok({}); }
  else process.exit(22);
} else {
  const map = load(${JSON.stringify(gh)});
  const u = new URL(url, "https://api.github.com/");
  const key = u.pathname.replace(/^\\/(repos\\/)?club\\/portal\\//, "").replace(/^\\/repos\\/club\\/portal\\//, "");
  const label = /^issues\\/(\\d+)\\/labels(?:\\/(.+))?$/.exec(key);
  if (label) {
    const n = label[1], have = new Set(map["labels/" + n] ?? []);
    if (method === "POST") fields.forEach((f) => have.add(f.split("=")[1]));
    if (method === "DELETE") have.delete(label[2]);
    map["labels/" + n] = [...have];
    writeFileSync(${JSON.stringify(gh)}, JSON.stringify(map));
    out([...have].map((name) => ({ name })));
  } else if (method !== "GET") out({});
  else if (Number(u.searchParams.get("page") ?? "1") > 1) out([]);
  else if (key in map) out(map[key]);
  else { process.stderr.write("no fake answer for " + key + "\\n"); process.exit(22); }
}
`);
  shim("curl", `exec "${node}" "${slash(http)}" curl "$@"`);
  shim("gh", `exec "${node}" "${slash(http)}" gh "$@"`);
  return {
    bin, log,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    github: (answers: Record<string, unknown>) => writeFileSync(gh, JSON.stringify({ ...JSON.parse(readFileSync(gh, "utf8")), ...answers })),
    labels: (n: number) => (JSON.parse(readFileSync(gh, "utf8"))[`labels/${n}`] ?? []) as string[],
    cloudflare: () => JSON.parse(readFileSync(cf, "utf8")) as { apps: { id: string; domain: string; policies: unknown }[]; records: { id: string; name: string; content: string; proxied: boolean }[] },
    setCloudflare: (change: object) => writeFileSync(cf, JSON.stringify({ ...JSON.parse(readFileSync(cf, "utf8")), ...change })),
    shim,
  };
}
const pullAnswer = (head: string | null, state = "open") => ({
  state, base: { repo: { full_name: "club/portal" } },
  head: { repo: head ? { full_name: head } : null, ref: "feature/x", sha: "a".repeat(40) },
});
const labeledBy = (login: string, ago: number) => [{ event: "labeled", label: { name: "preview" }, actor: { login }, created_at: iso(ago) }];

describe("preview.sh", { timeout: 30_000 }, () => {
  let dir: string, home: string, f: ReturnType<typeof fakes>;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "br-preview-"));
    home = path.join(dir, "preview-home");
    f = fakes(dir);
    mkdirSync(path.join(dir, "scripts", "poc"), { recursive: true });
    copyFileSync(path.resolve("scripts/poc/preview.sh"), path.join(dir, "scripts/poc/preview.sh"));
    writeFileSync(path.join(dir, ".env.poc"), "APP_URL=https://portal.example.org\nBETTER_AUTH_SECRET=site-secret-site-secret-site-secret-00\nDB_PASSWORD=site-db\nSETTINGS_ENCRYPTION_KEY=site-key\n");
    spawnSync("git", ["init", "-q", dir]);
    spawnSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/club/portal.git"]);
    // The edge network is there only once init makes it, and then answers "true" to --format, as an internal one would.
    // Its addresses, asked for by init, are 172.30.9.0/24. A build fails when build-fails exists.
    f.shim("docker", [
      `if [ "$1 $2" = "network inspect" ]; then`,
      `  case "$4" in *Subnet*) echo 172.30.9.0/24; exit 0;; esac`,
      `  [ "$3" = "--format" ] && { echo true; exit 0; }; exit 1`,
      `fi`,
      `case " $* " in *" build "*) [ -e "${slash(path.join(dir, "build-fails"))}" ] && exit 1;; esac`,
      `exit 0`,
    ].join("\n"));
    // Cloning and fetching do nothing (and are logged); anything else is git itself.
    // A fetched branch is at the commit GitHub names (aaaa...), and holds nothing.
    f.shim("git", [
      `case " $* " in`,
      `  *" clone "*) mkdir -p "\${@: -1}/.git"; exit 0;;`,
      `  *" fetch "*) exit 0;;`,
      `  *" rev-parse refs/preview/"*) echo ${"a".repeat(40)}; exit 0;;`,
      `  *" archive "*) tar -cf - -T /dev/null; exit 0;;`,
      `esac`,
      `exec "${slash(realGit)}" "$@"`,
    ].join("\n"));
  });
  const run = (...args: string[]) => spawnSync("bash", [path.join(dir, "scripts/poc/preview.sh"), ...args], {
    encoding: "utf8", env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, BR_DIR: dir, BR_PREVIEW_HOME: home },
  });
  const envFile = () => path.join(home, ".env.preview");
  const init = () => expect(run("init", "example.org", "Cf-Access-Jwt-Assertion", "owner-login").status).toBe(0);
  /** A preview that is up, as `up` leaves it. */
  const running = (n: number) => {
    mkdirSync(path.join(home, `pr-${n}`), { recursive: true });
    writeFileSync(path.join(home, `pr-${n}`, "current"), `pr=${n}\nbranch=feature/x\ncommit=${"a".repeat(40)}\nat=0\n`);
  };

  it("init writes the shared settings, names the repository from the checkout, keeps no Cloudflare token, and changes nothing of the site's", () => {
    init();
    const env = readFileSync(envFile(), "utf8");
    for (const line of ["PREVIEW_DOMAIN=example.org", "PREVIEW_GATE_HEADER=Cf-Access-Jwt-Assertion", "PREVIEW_REPO=club/portal", "PREVIEW_OWNER=owner-login", "PREVIEW_MAX=2", "PREVIEW_TTL_DAYS=7", "PREVIEW_EDGE_SUBNET=172.30.9.0/24"]) {
      expect(env.split("\n")).toContain(line);
    }
    expect(env).not.toMatch(/CF_|CLOUDFLARE/);
    expect(script).not.toMatch(/CF_API_TOKEN|api\.cloudflare\.com/);
    expect(f.calls()).toContain("docker network create --internal booster-rocket-preview-edge");
    expect(read(path.join(dir, ".env.poc"))).toContain("DB_PASSWORD=site-db");
  });

  it("init refuses a site named like a preview, a missing argument, or a domain that isn't one", () => {
    writeFileSync(path.join(dir, ".env.poc"), "APP_URL=https://pr-1-br.example.org\n");
    expect(run("init", "example.org", "X-Gate", "o").status, "the site at a preview's name").toBe(2);
    writeFileSync(path.join(dir, ".env.poc"), "APP_URL=https://portal.example.org\n");
    for (const args of [["example.org", "X-Gate"], ["https://example.org", "X-Gate", "o"], ["previews", "X-Gate", "o"]]) {
      const r = run("init", ...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(existsSync(envFile()), args.join(" ")).toBe(false);
    }
    expect(f.calls()).not.toContain("network create");
  });

  it.skipIf(!hasJq)("refuses a fork's pull request, or one whose fork is gone, before it fetches or builds anything", () => {
    init();
    for (const head of ["someone/portal", null]) {
      f.github({ "pulls/12": pullAnswer(head) });
      const r = run("up", "12");
      expect(r.status, String(head)).toBe(2);
      expect(r.stderr, String(head)).toContain("comes from a fork");
    }
    expect(f.calls()).not.toMatch(/git [^\n]*fetch|compose .*build|volume rm/);
  });

  it("fetches the branch itself, never the pull request's ref a fork writes", () => {
    expect(script).toContain('"+refs/heads/$PR_BRANCH:refs/preview/pr-$PREVIEW_PR"');
    expect(script).not.toMatch(/refs\/pull\//);
  });

  it("takes a pull request's number and nothing else", () => {
    init();
    for (const bad of ["", "0", "-1", "12a", "../1", "1234567", "main"]) {
      expect(run("up", bad).status, bad).toBe(2);
    }
    expect(f.calls()).not.toMatch(/http |compose .*build/);
  });

  it.skipIf(!hasJq)("refuses a third preview", () => {
    init();
    running(1); running(2);
    f.github({ "pulls/3": pullAnswer("club/portal") });
    const r = run("up", "3");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("2 previews are running already");
    expect(f.calls()).not.toMatch(/compose .*build/);
  });

  it.skipIf(!hasJq)("sweep takes nothing down when GitHub can't say who labeled a preview", () => {
    init();
    running(1);
    f.github({ "issues": [{ number: 1, pull_request: {} }] });
    const r = run("sweep");
    expect(r.status).toBe(5);
    expect(existsSync(path.join(home, "pr-1", "current"))).toBe(true);
    expect(f.calls()).not.toContain("volume rm");
  });

  it.skipIf(!hasJq)("poll builds a labeled pull request's commit once: a build that failed isn't tried again until the branch moves", () => {
    init();
    writeFileSync(path.join(dir, "build-fails"), "");
    f.github({ "issues": [{ number: 7, pull_request: {} }], "issues/7/events": labeledBy("github-actions[bot]", DAY), "pulls/7": pullAnswer("club/portal") });
    for (let i = 0; i < 2; i++) expect(run("poll").status).toBe(0);
    expect(f.calls().match(/compose [^\n]* build app/g)).toHaveLength(1);
    expect(readFileSync(path.join(home, "pr-7", "failed"), "utf8").trim()).toBe("a".repeat(40));
  });

  it.skipIf(!hasJq)("sweep keeps a preview the workflow or the owner labeled this week, and takes down every other", () => {
    init();
    for (const n of [1, 2, 3, 4, 5]) running(n);
    f.github({
      "issues": [1, 2, 3, 4].map((number) => ({ number, pull_request: {} })),
      "issues/1/events": labeledBy("github-actions[bot]", DAY),
      "issues/2/events": labeledBy("owner-login", 2 * DAY),
      "issues/3/events": labeledBy("someone-with-triage", DAY),
      "issues/4/events": labeledBy("github-actions[bot]", 8 * DAY),
    });
    const r = run("sweep");
    expect(r.status, r.stderr).toBe(0);
    // 3: labeled by someone else; 4: too old; 5: closed or unlabeled (not in the open, labeled list).
    for (const n of [1, 2]) expect(existsSync(path.join(home, `pr-${n}`)), String(n)).toBe(true);
    for (const n of [3, 4, 5]) {
      expect(existsSync(path.join(home, `pr-${n}`)), String(n)).toBe(false);
      expect(f.calls()).toContain(`docker volume rm booster-rocket-pr-${n}-db`);
    }
    expect(f.calls()).not.toMatch(/booster-rocket-pr-[12]-db/);
  });
});

describe.skipIf(!hasJq)("cloudflare.sh", { timeout: 30_000 }, () => {
  let dir: string, f: ReturnType<typeof fakes>;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "br-preview-cf-"));
    f = fakes(dir);
  });
  const env = { CF_API_TOKEN: "token", CF_ACCOUNT_ID: "acct", CF_ZONE_ID: "zone", CF_TUNNEL_ID: "tunnel-1", CF_ACCESS_POLICY_ID: "policy-1", PREVIEW_DOMAIN: "example.org" };
  const run = (...args: string[]) => spawnSync("bash", [path.resolve("scripts/poc/preview/cloudflare.sh"), ...args], {
    encoding: "utf8", env: { ...process.env, ...env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}` },
  });
  const order = () => f.calls().split("\n").filter((l) => /^http (POST|DELETE)/.test(l)).map((l) => l.replace(/^http (\w+) \S+\/client\/v4\/(\S+).*$/, "$1 $2"));

  it("opens a preview's gate: its Access application with the owner's policy first, then its DNS name to the tunnel", () => {
    const r = run("open", "12");
    expect(r.status, r.stderr).toBe(0);
    expect(order()).toEqual(["POST accounts/acct/access/apps", "POST zones/zone/dns_records"]);
    const { apps, records } = f.cloudflare();
    expect(apps).toMatchObject([{ domain: "pr-12-br.example.org", policies: [{ id: "policy-1" }] }]);
    expect(records).toMatchObject([{ name: "pr-12-br.example.org", content: "tunnel-1.cfargotunnel.com", proxied: true }]);
    // A second open finds both and makes nothing.
    expect(run("open", "12").status).toBe(0);
    expect(order()).toHaveLength(2);
  });

  it("never makes the DNS name when the Access application isn't there afterwards", () => {
    f.setCloudflare({ ghostApps: true });
    const r = run("open", "12");
    expect(r.status).toBe(5);
    expect(f.cloudflare().records).toEqual([]);
    expect(order()).toEqual(["POST accounts/acct/access/apps"]);
  });

  it("closes a preview's gate the other way round, keeps the application while the name is still there, and touches nothing else", () => {
    expect(run("open", "12").status).toBe(0);
    f.setCloudflare({ records: [...f.cloudflare().records, { id: "other", name: "portal.example.org" }], apps: [...f.cloudflare().apps, { id: "other-app", domain: "portal.example.org" }] });
    f.setCloudflare({ stuckRecords: true });
    expect(run("close", "12").status).toBe(5);
    expect(f.cloudflare().apps.map((a) => a.domain)).toContain("pr-12-br.example.org");
    f.setCloudflare({ stuckRecords: false });
    const r = run("close", "12");
    expect(r.status, r.stderr).toBe(0);
    const deletes = order().filter((l) => l.startsWith("DELETE"));
    expect(deletes.at(-2)).toMatch(/^DELETE zones\/zone\/dns_records\//);
    expect(deletes.at(-1)).toMatch(/^DELETE accounts\/acct\/access\/apps\//);
    expect(f.cloudflare().apps.map((a) => a.domain)).toEqual(["portal.example.org"]);
    expect(f.cloudflare().records.map((r) => r.name)).toEqual(["portal.example.org"]);
  });

  it("keeps the Access application when it can't look the DNS name up", () => {
    expect(run("open", "12").status).toBe(0);
    f.setCloudflare({ failRecordLookups: true });
    expect(run("close", "12").status).toBe(5);
    expect(order().filter((l) => l.startsWith("DELETE"))).toEqual([]);
    expect(f.cloudflare().apps.map((a) => a.domain)).toEqual(["pr-12-br.example.org"]);
  });

  it("lists only the previews' own names, and refuses anything but a number", () => {
    for (const n of ["3", "40"]) expect(run("open", n).status).toBe(0);
    f.setCloudflare({ records: [...f.cloudflare().records, { id: "x", name: "pr-9.example.org" }, { id: "y", name: "pr-7-br.example.org.evil.test" }] });
    expect(run("list").stdout.trim().split("\n")).toEqual(["3", "40"]);
    for (const bad of ["", "0", "1;x", "../1"]) expect(run("open", bad).status, bad).toBe(2);
    const missing = spawnSync("bash", [path.resolve("scripts/poc/preview/cloudflare.sh"), "open", "1"], { encoding: "utf8", env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}` } });
    expect(missing.status).toBe(2);
  });
});

describe.skipIf(!hasJq)("workflow.sh", { timeout: 30_000 }, () => {
  let dir: string, f: ReturnType<typeof fakes>;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "br-preview-wf-"));
    f = fakes(dir);
    // workflow.sh beside a stand-in for cloudflare.sh that logs what it is asked and lists the gates in gates.txt.
    mkdirSync(path.join(dir, "wf"));
    copyFileSync(path.resolve("scripts/poc/preview/workflow.sh"), path.join(dir, "wf/workflow.sh"));
    writeFileSync(path.join(dir, "gates.txt"), "");
    writeFileSync(path.join(dir, "wf/cloudflare.sh"), `#!/usr/bin/env bash\necho "cloudflare $*" >> "${slash(f.log)}"\n[ "$1" = list ] && cat "${slash(path.join(dir, "gates.txt"))}"\nexit 0\n`);
    chmodSync(path.join(dir, "wf/cloudflare.sh"), 0o755);
  });
  const run = (actor: string, ...args: string[]) => spawnSync("bash", [path.join(dir, "wf/workflow.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, GH_TOKEN: "t", PREVIEW_DOMAIN: "example.org",
      GITHUB_REPOSITORY: "club/portal", GITHUB_REPOSITORY_OWNER: "owner-login", GITHUB_ACTOR: actor, GITHUB_TRIGGERING_ACTOR: actor,
    },
  });
  const steps = () => f.calls().split("\n").filter((l) => /^cloudflare |^http (POST|DELETE)/.test(l)).map((l) => l.replace(/^http (\w+) \S*?(issues\/\d+\/\w+).*$/, "$1 $2"));

  it("lets only the owner start a preview", () => {
    f.github({ "pulls/12": pullAnswer("club/portal"), "issues": [] });
    const r = run("someone-with-write", "up", "12");
    expect(r.status).toBe(2);
    expect(steps()).toEqual([]);
  });

  it("refuses a fork's pull request, a closed one, or a third preview, before it opens anything", () => {
    for (const [answer, words] of [[pullAnswer("someone/portal"), "comes from a fork"], [pullAnswer(null), "comes from a fork"], [pullAnswer("club/portal", "closed"), "isn't open"]] as const) {
      f.github({ "pulls/12": answer, "issues": [] });
      const r = run("owner-login", "up", "12");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(words);
    }
    f.github({ "pulls/12": pullAnswer("club/portal"), "issues": [{ number: 1, pull_request: {} }, { number: 2, pull_request: {} }] });
    const third = run("owner-login", "up", "12");
    expect(third.status).toBe(2);
    expect(third.stderr).toContain("2 previews are up already");
    expect(steps()).toEqual([]);
  });

  it("opens the gate before it labels the pull request, and says where the preview will be", () => {
    f.github({ "pulls/12": pullAnswer("club/portal"), "issues": [{ number: 1, pull_request: {} }] });
    const r = run("owner-login", "up", "12");
    expect(r.status, r.stderr).toBe(0);
    expect(steps()).toEqual(["cloudflare open 12", "POST issues/12/labels", "POST issues/12/comments"]);
    expect(f.labels(12)).toEqual(["preview"]);
    expect(f.calls()).toContain("https://pr-12-br.example.org");
  });

  it("closes the gate before it takes the label off", () => {
    f.github({ "labels/12": ["preview"] });
    const r = run("anyone", "down", "12");
    expect(r.status, r.stderr).toBe(0);
    expect(steps()).toEqual(["cloudflare close 12", "DELETE issues/12/labels"]);
    expect(f.labels(12)).toEqual([]);
  });

  it("closes nothing when it can't read which pull requests are labeled", () => {
    writeFileSync(path.join(dir, "gates.txt"), "1\n2\n");
    const r = run("github-actions[bot]", "sweep");
    expect(r.status).toBe(5);
    expect(steps()).toEqual([]);
  });

  it("sweeps closed, stale and stray previews, and keeps a fresh one", () => {
    writeFileSync(path.join(dir, "gates.txt"), "1\n2\n3\n4\n9\n");
    f.github({
      "issues": [1, 2, 3, 4].map((number) => ({ number, pull_request: {} })),
      "pulls/1": pullAnswer("club/portal"), "pulls/2": pullAnswer("club/portal", "closed"),
      "pulls/3": pullAnswer("club/portal"), "pulls/4": pullAnswer("club/portal"),
      "issues/1/events": labeledBy("github-actions[bot]", DAY),
      "issues/2/events": labeledBy("github-actions[bot]", DAY),
      "issues/3/events": labeledBy("github-actions[bot]", 8 * DAY),
      "issues/4/events": labeledBy("someone-with-triage", DAY),
      "labels/1": ["preview"], "labels/2": ["preview"], "labels/3": ["preview"], "labels/4": ["preview"],
    });
    const r = run("github-actions[bot]", "sweep");
    expect(r.status, r.stderr).toBe(0);
    const closed = steps().filter((l) => l.startsWith("cloudflare close")).map((l) => l.split(" ")[2]).sort();
    expect(closed).toEqual(["2", "3", "4", "9"]);
    expect(f.labels(1)).toEqual(["preview"]);
    for (const n of [2, 3, 4]) expect(f.labels(n), String(n)).toEqual([]);
  });
});

describe("the previews workflow", () => {
  const workflow = read(".github/workflows/previews.yml");
  const on = block(workflow, "on", 0);

  it("starts only by hand, on a pull request's close, or on its daily schedule", () => {
    expect([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1])).toEqual(["workflow_dispatch", "pull_request_target", "schedule"]);
    expect(block(on, "pull_request_target", 2)).toMatch(/types: \[closed\]/);
  });

  it("never runs a pull request's code: main's checkout, no credentials kept, nothing of the pull request's in a script", () => {
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toMatch(/github\.event\.pull_request\.head|github\.head_ref/);
    const run = workflow.slice(workflow.indexOf("run: |"));
    expect(run).not.toContain("${{");
    expect([...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]!)).toEqual(["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"]);
  });

  it("lets only the owner start it by hand, and only from main, on GitHub's own runners", () => {
    expect(workflow).toMatch(/github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\s+&& github\.actor == github\.repository_owner && github\.triggering_actor == github\.repository_owner/);
    expect(workflow).toMatch(/github\.event_name == 'pull_request_target' && contains\(github\.event\.pull_request\.labels\.\*\.name, 'preview'\)/);
    expect(workflow).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toMatch(/^ {4}environment: previews$/m);
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
