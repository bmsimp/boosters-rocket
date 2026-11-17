import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The built-in proxy (deploy/compose.yml, profile "proxy") starts through deploy/proxy-start.sh, which refuses an
 * address Caddy would read a path from. "https://portal.example.org/" as a site address matches the exact path "/"
 * alone, so every other page of the portal would come back empty, with nothing in any log.
 */
const SCRIPT = path.resolve("deploy/proxy-start.sh");
let dir: string, log: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "br-proxy-start-"));
  log = path.join(dir, "caddy.log");
  // Caddy is stood in for: it records how it was started.
  writeFileSync(path.join(dir, "caddy"), `#!/bin/sh\necho "caddy $*" >> ${JSON.stringify(log.replace(/\\/g, "/"))}\n`);
  chmodSync(path.join(dir, "caddy"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const start = (APP_URL: string, DOCUMENSO_URL: string) => {
  rmSync(log, { force: true });
  const r = spawnSync("sh", [SCRIPT], { encoding: "utf8", env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, APP_URL, DOCUMENSO_URL } });
  let ran = "";
  try { ran = readFileSync(log, "utf8"); } catch { /* not started */ }
  return { ...r, ran };
};

describe("deploy/proxy-start.sh", () => {
  it.each([["https://portal.example.org", "https://sign.example.org"], ["http://portal.example.org:8080", "https://sign.example.org:8443"]])(
    "starts Caddy with its Caddyfile for %s and %s", (app, documenso) => {
      const r = start(app, documenso);
      expect(r.status, r.stderr).toBe(0);
      expect(r.ran).toBe("caddy run --config /etc/caddy/Caddyfile --adapter caddyfile\n");
    });

  it.each([
    ["APP_URL", "https://portal.example.org/", "https://sign.example.org"],
    ["APP_URL", "https://portal.example.org/portal", "https://sign.example.org"],
    ["APP_URL", "portal.example.org", "https://sign.example.org"],
    ["APP_URL", "", "https://sign.example.org"],
    ["DOCUMENSO_URL", "https://portal.example.org", "https://sign.example.org/"],
    ["DOCUMENSO_URL", "https://portal.example.org", "https://sign.example.org/?x=1"],
    ["DOCUMENSO_URL", "https://portal.example.org", "https://user@sign.example.org"],
  ])("refuses %s in %j / %j and never starts Caddy", (which, app, documenso) => {
    const r = start(app, documenso);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${which} in deploy/.env must be the address and nothing after it`);
    expect(r.ran).toBe("");
  });

  it("is how the compose file starts the proxy", () => {
    const compose = readFileSync(path.resolve("deploy/compose.yml"), "utf8");
    const proxy = compose.slice(compose.indexOf("\n  proxy:"));
    expect(proxy).toContain('command: ["sh", "/etc/caddy/proxy-start.sh"]');
    expect(proxy).toContain("./proxy-start.sh:/etc/caddy/proxy-start.sh:ro");
  });
});
