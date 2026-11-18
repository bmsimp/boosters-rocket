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

describe("what the runbooks tell an Admin to do with QuickBooks", () => {
  const health = section(read("docs/runbooks/health-warnings.md"), "QuickBooks");
  it("never tells an installation on the real books to connect the sandbox: a change of company is refused until the mapping screen ships", () => {
    expect(health).not.toMatch(/connect the Intuit sandbox company/i);
    expect(health).not.toMatch(/then reconnect the real company/i);
    expect(health).toMatch(/never by switching this installation's\s+company/);
    expect(health).toContain("(quickbooks-reconnect.md#connecting-a-different-company)");
    // The refused read says to disconnect first, and the runbook has its entry (roster_company).
    expect(read("src/lib/roster/refresh.ts")).toContain("Disconnect QuickBooks, then connect the company the roster was read from. (roster_company)");
    expect(health).toContain("(`roster_company`)");
  });

  it("says a different company is refused for now, and sends a sandbox trial to the proof-of-concept host", () => {
    const reconnect = section(read("docs/runbooks/quickbooks-reconnect.md"), "Connecting a different company");
    expect(reconnect).toMatch(/\*\*Not possible yet\.\*\*/);
    expect(reconnect).toMatch(/proof-of-concept host/);
    expect(section(read("docs/runbooks/intuit.md"), "2. Try it on a sandbox company first")).toMatch(/proof-of-concept host/);
    for (const doc of ["docs/runbooks/quickbooks-reconnect.md", "docs/runbooks/intuit.md", "docs/runbooks/health-warnings.md", "docs/runbooks/before-the-first-family.md", "docs/runbooks/poc-linuxdev.md"]) {
      expect(read(doc), doc).not.toMatch(/connecting a different (QuickBooks )?company (deletes|clears|ends|switches)/i);
    }
  });

  it("names the button a disconnected company shows, Change: Disconnect keeps the app's keys", () => {
    expect(read("src/app/staff/(app)/settings/quickbooks/page.tsx")).toContain(`conn.configured ? "Change" : "Set up"`);
    const intuit = section(read("docs/runbooks/intuit.md"), "4. Connect the club's real books");
    const reconnect = section(read("docs/runbooks/quickbooks-reconnect.md"), "Connecting a different company");
    for (const steps of [intuit, reconnect]) {
      expect(steps).not.toMatch(/\*\*Set up\*\*/);
      expect(steps).toMatch(/\*\*Change\*\*/);
    }
  });
});

describe("the owner's runbook, in its order", () => {
  const runbook = read("docs/runbooks/before-the-first-family.md");
  const part1 = section(runbook, "1. Push, and deploy to the proof-of-concept host");
  it("brings the deploy script up to date and backs up by hand before the first deploy, which the old copy would run without a backup", () => {
    const deploy = part1.slice(part1.indexOf("4. **Deploy**"), part1.indexOf("5. **Open the Health page**"));
    const pull = deploy.indexOf("git pull --ff-only"), backup = deploy.indexOf("scripts/backup.sh ~/booster-rocket-backups"), run = deploy.indexOf("scripts/poc/deploy.sh");
    expect(pull).toBeGreaterThan(0);
    expect(backup).toBeGreaterThan(pull);
    expect(run).toBeGreaterThan(backup);
  });

  it("leaves check 25, a second sandbox company, for the mapping screen, so the host stays on the first one part 2 needs", () => {
    const checks = part1.slice(part1.indexOf("8. **Run checks 18 to 24**"), part1.indexOf("9. **Export"));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks).toMatch(/Check 25, a second sandbox company, and the match review that follows it, wait for the mapping screen/);
    expect(checks).not.toMatch(/connect the first sandbox company/);
  });

  it("asks GitHub for Dependabot's security updates, which only the repository's settings switch on", () => {
    expect(part1).toMatch(/\*\*Dependabot security updates\*\*/);
  });

  it("passes CI on what the log shows, and the contrast check on what a notice now has", () => {
    expect(part1).not.toContain("booster_w2_test");
    expect(runbook).not.toMatch(/notices keep their left edge/);
  });

  it("doesn't pass the sandbox check while any change went untried", () => {
    expect(section(runbook, "2. Check the portal's requests in the Intuit sandbox")).toMatch(/no row under \*\*Changing \(sandbox only\)\*\* reads "Not tried"/);
  });
});
