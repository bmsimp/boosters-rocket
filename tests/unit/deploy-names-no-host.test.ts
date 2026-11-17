import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A club installs the portal on a host of its own choosing (roadmap, owner's decision 6), so what it installs from and
 * follows names no host. This reads the installation folder, the runbooks (but the proof of concept's, which is the
 * record of one host) and the release and dependency-update files, and fails on:
 *  - a host name or domain, other than example.com and example.org and the public sites a step has to name;
 *  - an IP address, other than this machine's own and the ranges set aside for documentation;
 *  - a hosting or certificate provider's name;
 *  - anything that looks like a secret.
 * A new public site a runbook truly needs is added to SITES with the step that needs it, never in passing.
 */
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const walk = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap((name) => {
  const rel = `${dir}/${name}`;
  return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
});

const PROOF_OF_CONCEPT = "docs/runbooks/poc-linuxdev.md";
const SCANNED = [
  ...walk("deploy"),
  ...walk("docs/runbooks").filter((f) => f !== PROOF_OF_CONCEPT),
  ".github/workflows/release.yml",
  ".github/dependabot.yml",
];

/** The public sites a step must name, each with why. A name here also allows its subdomains. */
const SITES: Record<string, string> = {
  "example.com": "examples only",
  "example.org": "examples only",
  "github.com": "the repository, its releases and its container registry",
  "ghcr.io": "the GitHub Container Registry the published image lives in",
  "docker.com": "Docker's own documentation and Docker Hub",
  "developer.intuit.com": "registering the Intuit app (intuit.md)",
  "docs.documenso.com": "Documenso's own documentation",
  "caddyserver.com": "the proxy's own documentation (deploy/Caddyfile)",
  "smtp.office365.com": "Microsoft 365's SMTP server, for Documenso's account mail (mail.md)",
};
const TLDS = "com|org|net|io|dev|app|co|us|uk|ca|au|de|eu|fr|nl|edu|gov|info|biz|me|xyz|site|online|tech|ai|cloud|club|school|team|tv|cc|ly|gg|in|link|page|run|host|systems|network";
const HOST = new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})\\b`, "gi");
const allowedHost = (host: string) => Object.keys(SITES).some((site) => host === site || host.endsWith(`.${site}`));

/** Hosting, tunnel and certificate providers a club might use: the portal depends on none of them. */
const PROVIDERS = ["cloudflare", "aws", "amazon", "azure", "digitalocean", "digital ocean", "linode", "akamai", "hetzner", "vultr", "ovh", "heroku",
  "vercel", "netlify", "fly.io", "railway", "google cloud", "gcp", "oracle cloud", "scaleway", "tailscale", "ngrok", "let's encrypt", "letsencrypt",
  "zerossl", "digicert", "globalsign", "sectigo", "freetsa", "godaddy", "namecheap", "linuxdev", "rhinoautomator", "fznband", "portaltest"];
const providerPattern = new RegExp(`(?<![a-z0-9-])(?:${PROVIDERS.map((p) => p.replace(/[.']/g, (c) => `\\${c}`)).join("|")})(?![a-z0-9-])`, "gi");

const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const allowedIp = (ip: string) => ip === "127.0.0.1" || ip === "0.0.0.0" || /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip);

/** What a secret looks like when it is written down instead of read from the env. */
function secretsIn(text: string): string[] {
  const found: string[] = [];
  // Long hex: a key or a token. An image digest (sha256:...) and a commit an action is pinned to (@...) are not secrets.
  for (const m of text.matchAll(/(?<![0-9a-f:@])[0-9a-f]{32,}(?![0-9a-f])/gi)) found.push(m[0]);
  // A base64 blob long enough to be a key, with digits and both cases in it.
  for (const m of text.matchAll(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/g)) if (/\d/.test(m[0]) && /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0])) found.push(m[0]);
  for (const m of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|GOCSPX-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,})/g)) found.push(m[0]);
  return found;
}

function problemsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(HOST)) if (!allowedHost(m[0].toLowerCase())) out.push(`host ${m[0]}`);
  for (const m of text.matchAll(IPV4)) if (!allowedIp(m[0])) out.push(`address ${m[0]}`);
  for (const m of text.matchAll(providerPattern)) out.push(`provider ${m[0]}`);
  for (const s of secretsIn(text)) out.push(`secret-like ${s.slice(0, 12)}...`);
  return out;
}

describe("the tripwire itself", () => {
  it("catches a host, an address, a provider and a secret, and lets the allowed ones through", () => {
    expect(problemsIn("Open https://portal.someclub.org and sign.club-boosters.net")).toEqual(["host portal.someclub.org", "host sign.club-boosters.net"]);
    expect(problemsIn("APP_URL=http://10.1.2.3:3000 or 172.20.0.1")).toEqual(["address 10.1.2.3", "address 172.20.0.1"]);
    expect(problemsIn("behind Cloudflare, or on Azure, or with Let's Encrypt")).toEqual(["provider Cloudflare", "provider Azure", "provider Let's Encrypt"]);
    expect(problemsIn("BETTER_AUTH_SECRET=4f0c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39")).toHaveLength(1);
    expect(problemsIn("SETTINGS_ENCRYPTION_KEY=Y2ktZmFrZS1rZXktY2ktZmFrZS1rZXktY2ktZmFrZSE=")).toHaveLength(1);
    expect(problemsIn("token api_abcdefghijklmnop")).toHaveLength(1);
    expect(problemsIn([
      "https://portal.example.org and forms@example.org, https://sign.example.com, https://github.com/x, ghcr.io/<owner>/booster-rocket",
      "image: postgres:16.16@sha256:dd2bf3ce2dc83a81674cf7f217fcfd8a5009a4b325dda5b843bfee82a06cff6f",
      "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "http://127.0.0.1:3000, 203.0.113.7, deploy/compose.yml, scripts/backup.sh, cert.p12, cf-connecting-ip, x-forwarded-for, the Amazonian",
    ].join("\n"))).toEqual([]);
  });
});

describe("the installation, the runbooks and the release name no host and hold no secret", () => {
  it("reads every file it should, and leaves out only the proof of concept's runbook", () => {
    expect(SCANNED).toEqual(expect.arrayContaining(["deploy/compose.yml", "deploy/compose.build.yml", "deploy/.env.example", "deploy/Caddyfile",
      "deploy/initdb/10-databases.sql", "docs/runbooks/first-install.md", "docs/runbooks/intuit.md", "docs/runbooks/mail.md", "docs/runbooks/documenso.md",
      "docs/runbooks/backups.md", "docs/runbooks/updates.md", "docs/runbooks/restore.md", "docs/runbooks/quickbooks-reconnect.md",
      "docs/runbooks/health-warnings.md", "docs/runbooks/before-the-first-family.md", ".github/workflows/release.yml", ".github/dependabot.yml"]));
    expect(SCANNED).not.toContain(PROOF_OF_CONCEPT);
  });

  it.each(SCANNED)("%s", (file) => {
    expect(problemsIn(read(file))).toEqual([]);
  });

  it("leaves every secret in the env example empty, for the club to make its own", () => {
    const secretLines = read("deploy/.env.example").split("\n").filter((l) => /^[A-Z0-9_]*(PASSWORD|SECRET|PASSPHRASE|_KEY|TOKEN)[A-Z0-9_]*=/.test(l));
    expect(secretLines.length).toBeGreaterThanOrEqual(10);
    for (const line of secretLines) expect(line, line).toMatch(/=$/);
  });

  it("gives every address and choice of the club's no default in the compose file, and reads every secret from the env", () => {
    const compose = read("deploy/compose.yml");
    for (const name of ["APP_URL", "DOCUMENSO_URL", "CLUB_TIME_ZONE", "CLIENT_IP_HEADER", "POSTGRES_SUPERUSER_PASSWORD", "PORTAL_DB_PASSWORD", "DOCUMENSO_DB_PASSWORD",
      "BETTER_AUTH_SECRET", "SETTINGS_ENCRYPTION_KEY", "DOCUMENSO_NEXTAUTH_SECRET", "DOCUMENSO_ENCRYPTION_KEY", "DOCUMENSO_ENCRYPTION_SECONDARY_KEY",
      "DOCUMENSO_SIGNING_CERTIFICATE", "DOCUMENSO_SIGNING_PASSPHRASE", "BACKUP_DIR"]) {
      expect(compose, name).toContain(`\${${name}:?`);
      expect(compose, name).not.toMatch(new RegExp(`\\$\\{${name}:-`));
    }
    for (const line of compose.split("\n").filter((l) => /^\s+[A-Z_]*(PASSWORD|SECRET|PASSPHRASE|_KEY):/.test(l))) expect(line, line).toMatch(/:\s+\$\{/);
  });

  it("pins every image the compose file pulls to a digest, but the portal's own, which the club names", () => {
    const images = [...read("deploy/compose.yml").matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(images.length).toBeGreaterThanOrEqual(7);
    for (const image of images) {
      if (image.startsWith("${BOOSTER_ROCKET_IMAGE")) continue;
      expect(image, image).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
    }
    expect(images).toContain("documenso/documenso:v2.22.0@sha256:f9976d2142d34ee89506e161b0a5ec859a0c327f3fe0a398b46d3941fc8dd35e");
  });
});

describe("the release workflow", () => {
  const release = read(".github/workflows/release.yml");

  it("runs when a release is published, may write packages and read the code, and nothing more", () => {
    expect(release).toMatch(/^on:\n {2}release:\n {4}types: \[published\]/m);
    expect(release).toMatch(/^permissions:\n {2}contents: read\n {2}packages: write\n\n/m);
  });

  it("pins every action it uses to a commit", () => {
    const uses = [...release.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it("checks the image as CI does before it pushes anything", () => {
    const at = (s: string) => release.indexOf(s);
    expect(at("bash scripts/smoke-image.sh")).toBeGreaterThan(0);
    expect(at("bash scripts/check-image-secrets.sh")).toBeGreaterThan(at("bash scripts/smoke-image.sh"));
    expect(at("docker push")).toBeGreaterThan(at("bash scripts/check-image-secrets.sh"));
    expect(release).toContain('--build-arg "APP_COMMIT=${GITHUB_SHA}"');
  });

  it("takes the registry path from the workflow's context and uses only the token the run is given", () => {
    expect(release).toContain('image="${REGISTRY}/${GITHUB_REPOSITORY,,}"');
    expect(release).not.toMatch(/ghcr\.io\/[a-z0-9]/i);
    expect([...release.matchAll(/\$\{\{\s*secrets\.(\w+)/g)].map((m) => m[1])).toEqual(["GITHUB_TOKEN"]);
    expect(release).toContain('tags=("$VERSION" "$COMMIT")');
    expect(release).toMatch(/if \[ "\$PRERELEASE" != "true" \]; then tags\+=\(stable\); fi/);
  });
});

describe("the dependency updates", () => {
  const dependabot = read(".github/dependabot.yml");

  it("watch the packages, the Dockerfile, the installation's images and the workflows, monthly and grouped", () => {
    const blocks = dependabot.split(/\n {2}- package-ecosystem: /).slice(1);
    expect(blocks.map((b) => `${b.split("\n")[0]} ${/directory: (\S+)/.exec(b)?.[1]}`)).toEqual(["npm /", "docker /", "docker-compose /deploy", "github-actions /"]);
    for (const b of blocks) {
      expect(b).toContain("interval: monthly");
      expect(b).toMatch(/groups:\n\s+\w+:\n\s+patterns: \["\*"\]/);
    }
  });
});
