import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * What a club volunteer follows at the keyboard (docs/runbooks/) against what the installation really does: the setup
 * page's steps in their order, the checks a first start needs whichever proxy is in front, and the files a volunteer
 * must be able to copy off the machine as themselves.
 */
const read = (file: string) => readFileSync(path.resolve(file), "utf8");
const section = (text: string, heading: string) => {
  const at = text.indexOf(`\n## ${heading}`);
  if (at < 0) throw new Error(`no section "${heading}"`);
  const next = text.indexOf("\n## ", at + 1);
  return text.slice(at, next < 0 ? undefined : next);
};

/** The setup page's steps, in order (src/lib/setup/state.ts), and the words the runbooks give each. */
const STEPS = [.../SETUP_STEPS = \[([^\]]+)\]/.exec(read("src/lib/setup/state.ts"))![1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
const WORDS: Record<string, string> = { club: "the club", staff: "staff sign-in", mail: "outgoing mail", admin: "first Admin" };

describe("the first installation's setup section", () => {
  it("names the setup page's steps by their numbers, in the page's order", () => {
    expect(STEPS.length).toBeGreaterThan(0);
    const setup = section(read("docs/runbooks/first-install.md"), "6. Setup");
    const found = [...setup.matchAll(/\*\*Step (\d), ([^.]+)\.\*\*/g)].map((m) => [Number(m[1]), m[2]]);
    expect(found).toEqual(STEPS.map((s, i) => [i + 1, WORDS[s]]));
  });

  it("sends the mail runbook's readers to the step numbers the page shows", () => {
    const mail = read("docs/runbooks/mail.md");
    const numbers = [...mail.matchAll(/[Ss]tep (\d)/g)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) expect(["staff", "mail"]).toContain(STEPS[n - 1]);
    expect(mail).toContain(`setup Step ${STEPS.indexOf("staff") + 1}`);
    expect(mail).toContain(`setup page's Step ${STEPS.indexOf("mail") + 1}`);
  });
});

describe("the first start", () => {
  it("checks that the machine reaches its own two addresses, both ways, whichever proxy is in front", () => {
    const start = section(read("docs/runbooks/first-install.md"), "5. The first start");
    expect(start).toMatch(/docker compose exec app node -e .*"<DOCUMENSO_URL>"/);
    expect(start).toMatch(/docker compose exec documenso node -e .*"<APP_URL>"/);
    expect(start).toMatch(/with either kind of proxy/);
  });

  it("gives the setup code the portal's address to print", () => {
    const compose = read("deploy/compose.yml");
    const migrate = compose.slice(compose.indexOf("\n  migrate:"), compose.indexOf("\n  app:"));
    expect(migrate).toMatch(/APP_URL: \$\{APP_URL\}/);
  });
});

describe("what a volunteer copies off the machine", () => {
  it("copies the backups as the folder's owner, who alone can read them", () => {
    expect(section(read("docs/runbooks/backups.md"), "Copying the backups off this machine")).toMatch(/run the copy as that person/);
  });

  it("keeps the signing certificate's copy before handing the file to Documenso's user", () => {
    const part1 = section(read("docs/runbooks/documenso.md"), "1. Make the signing certificate");
    const copy = part1.indexOf("Keep a copy of `documenso-signing.p12`"), chown = part1.indexOf("sudo chown 1001");
    expect(copy).toBeGreaterThan(0);
    expect(chown).toBeGreaterThan(copy);
  });
});
