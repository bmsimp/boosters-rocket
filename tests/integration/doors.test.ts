import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { asParent, asStaff, pageOutcome, type Page } from "../helpers/signed-in";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, role, roleAssignment, roleRule } from "@/lib/db/schema";
import { AccessDenied, guardOf } from "@/lib/guards";
import { can, effectivePermissions } from "@/lib/permissions/effective";
import { ADMIN_ONLY, type Permission } from "@/lib/permissions/registry";
import { resetDb, seedStaff } from "../helpers/db";
import { moneyMarkers, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { mintLink, unknownToken } from "../helpers/signin-links";

/**
 * Three of the v1 spec's privacy invariants (§12), checked for everything on disk rather than page by page:
 *
 *   2. Every staff handler declares a permission (§7), and a test calls each one without it and expects a refusal.
 *      tests/integration/invariants.test.ts reads that every exported staff action is wrapped in staffAction() with a
 *      permission; here each one is called by a staff member who holds every other permission a role can hold, and by
 *      a parent, and must be refused before it runs, with the refusal audited.
 *   3. Parent pages refuse staff sessions, and staff pages refuse parent sessions: each page is asked for with the
 *      other door's session only, an Admin's at that, and must send the visitor to its own door's sign-in.
 *   4. Public pages (sign-in, the refusal, errors) contain no family data: each is rendered with no session against a
 *      database holding two families, and must show none of either family's names, ids, addresses or amounts.
 */
const root = path.resolve(__dirname, "../..");
const filesUnder = (dir: string) => readdirSync(path.join(root, dir), { recursive: true }).map((f) => `${dir}/${String(f).replaceAll("\\", "/")}`);
const startsWithUseServer = (source: string) => /^(["'])use server\1/.test(source.replace(/^﻿/, "").replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, ""));

const staffActionModules = filesUnder("src/app/staff").filter((f) => /\.tsx?$/.test(f) && startsWithUseServer(readFileSync(path.join(root, f), "utf8")));
const staffPages = filesUnder("src/app/staff/(app)").filter((f) => /\/page\.tsx$/.test(f));
const parentPages = filesUnder("src/app/(parent)").filter((f) => /\/page\.tsx$/.test(f));

const load = async (file: string): Promise<Page> => ((await import(path.join(root, file))) as { default: Page }).default;
/** Any value for each dynamic segment: the guard is the page's first line, so no id is ever looked at. */
const dummyParams = (file: string) => Object.fromEntries([...file.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((m) => [m[1]!, "00000000-0000-4000-8000-000000000000"]));

async function staffHolding(email: string, include: string[], exclude: string[] = []) {
  const s = await seedStaff({ email, name: email });
  const [r] = await db.insert(role).values({ key: `role-${email}`, name: email }).returning();
  await db.insert(roleRule).values([...include.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })),
    ...exclude.map((pattern) => ({ roleId: r!.id, kind: "exclude" as const, pattern }))]);
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
}

type StaffAction = { file: string; name: string; fn: (...a: never[]) => Promise<unknown>; permission: Permission };
async function staffActions(): Promise<StaffAction[]> {
  const found: StaffAction[] = [];
  for (const file of staffActionModules) {
    const mod = (await import(path.join(root, file))) as Record<string, unknown>;
    for (const [name, fn] of Object.entries(mod)) {
      const g = guardOf(fn);
      // staffSelfAction: a staff member's own record, with no permission to hold back (src/lib/guards.ts).
      if (typeof fn === "function" && g?.door === "staff" && g.permission) found.push({ file, name, fn: fn as StaffAction["fn"], permission: g.permission as Permission });
    }
  }
  return found;
}

describe("invariant 2: every staff action is refused to whoever lacks its permission, before it runs", () => {
  let actions: StaffAction[];
  beforeAll(async () => { actions = await staffActions(); });
  beforeEach(resetDb);

  it("finds the staff actions on disk", () => {
    expect(staffActionModules.length).toBeGreaterThan(5);
    expect(actions.length).toBeGreaterThan(50);
  });

  it("refuses each to a staff member who holds every other permission a role can hold, and audits the refusal with the permission it needed", async () => {
    const unrefused: string[] = [];
    for (const [i, a] of actions.entries()) {
      // An Admin-only permission is never in a custom role, so the widest role there is lacks it; any other is left out by name.
      const s = await staffHolding(`staff${i}@club.org`, ["*"], ADMIN_ONLY.includes(a.permission) ? [] : [a.permission]);
      expect(can(await effectivePermissions(s.id), a.permission), `${a.permission} could not be left out of a role`).toBe(false);
      asStaff(s);
      const outcome = await a.fn().then(() => "ran", (e: unknown) => (e instanceof AccessDenied ? "refused" : `threw ${String(e)}`));
      if (outcome !== "refused") unrefused.push(`${a.file} → ${a.name} (${a.permission}) ${outcome}`);
      const refusals = await db.select().from(auditLog).where(and(eq(auditLog.action, "access.refused"), eq(auditLog.actorId, s.id)));
      expect(refusals.map((r) => r.permission), `${a.file} → ${a.name}`).toEqual([a.permission]);
    }
    expect(unrefused, "Every exported staff action is staffAction(\"Its.Permission\", ...): the guard refuses before the action reads its arguments.").toEqual([]);
  }, 120_000);

  it("refuses each to a parent's session, whatever family it holds", async () => {
    const { a } = await seedTwoFamilies();
    asParent(a.identity);
    const unrefused: string[] = [];
    for (const x of actions) {
      const outcome = await x.fn().then(() => "ran", (e: unknown) => (e instanceof AccessDenied ? "refused" : `threw ${String(e)}`));
      if (outcome !== "refused") unrefused.push(`${x.file} → ${x.name} ${outcome}`);
    }
    expect(unrefused).toEqual([]);
  }, 120_000);
});

describe("invariant 3: each door's pages refuse the other door's session", () => {
  beforeEach(resetDb);

  it("finds the pages of both doors", () => {
    expect(staffPages.length).toBeGreaterThan(20);
    expect(parentPages.length).toBeGreaterThan(5);
  });

  it("sends a signed-in parent who asks for a staff page to the staff sign-in, page by page", async () => {
    const { a } = await seedTwoFamilies();
    asParent(a.identity);
    for (const file of staffPages) {
      expect(await pageOutcome(await load(file), { params: dummyParams(file) }), file).toEqual({ redirect: "/staff/sign-in" });
    }
  }, 120_000);

  it("sends an Admin with no parent session who asks for a parent page to the parent sign-in, page by page", async () => {
    asStaff(await seedStaff({ email: "admin@club.org", admin: true }));
    for (const file of parentPages) {
      const outcome = await pageOutcome(await load(file), { params: dummyParams(file) });
      expect("redirect" in outcome && /^\/sign-in(\?|$)/.test(outcome.redirect), `${file}: ${JSON.stringify(outcome)}`).toBe(true);
    }
  }, 120_000);
});

describe("invariant 4: the public pages show no family data", () => {
  let a: SeededParent, b: SeededParent;
  beforeAll(async () => { await resetDb(); ({ a, b } = await seedTwoFamilies()); });

  /** Every public page there is: the two sign-in doors, the refusal, the not-found page and the error pages (the set-up and reset links' pages, which need a link, below). */
  const PUBLIC: { file: string; props?: object }[] = [
    { file: "src/app/sign-in/page.tsx" },
    // With a return address that names one family's form: the page still says nothing about it.
    { file: "src/app/sign-in/page.tsx", props: { searchParams: { next: "/forms/00000000-0000-4000-8000-000000000000" } } },
    { file: "src/app/staff/sign-in/page.tsx" },
    { file: "src/app/refused/page.tsx" },
    { file: "src/app/not-found.tsx" },
  ];
  const markers = () => [...a.markers, ...b.markers, ...moneyMarkers(a.spec), ...moneyMarkers(b.spec), ...a.season!.staffOnly, ...b.season!.staffOnly];

  it.each(PUBLIC)("$file shows a visitor with no session none of either family's data", async ({ file, props }) => {
    const outcome = await pageOutcome(await load(file), props);
    if (!("html" in outcome)) expect.fail(`${file} did not render for a visitor with no session: ${JSON.stringify(outcome)}`);
    const text = outcome.html.toLowerCase();
    expect(markers().filter((m) => text.includes(m.toLowerCase()))).toEqual([]);
  });

  // The set-up and reset pages (slice SI-2) are public too: with a token that names no link (the refusal), and with a
  // live link of family A's own parent (the form), they show none of either family's data, A's included.
  it.each([["set-up", "setup"], ["reset", "reset"]] as const)("the %s link's page shows a visitor with no session none of either family's data", async (folder, purpose) => {
    const Page = await load(`src/app/sign-in/${folder}/[token]/page.tsx`);
    const live = await mintLink(a.identity.parentId, purpose);
    for (const [token, form] of [[unknownToken(), false], [live, true]] as const) {
      const outcome = await pageOutcome(Page, { params: { token } });
      if (!("html" in outcome)) expect.fail(`${folder} did not render for a visitor with no session: ${JSON.stringify(outcome)}`);
      expect(outcome.html.includes('type="password"'), `${folder}: the form is shown only for a live link`).toBe(form);
      const text = outcome.html.toLowerCase();
      expect(markers().filter((m) => text.includes(m.toLowerCase()))).toEqual([]);
    }
  });

  it("the family chooser sends a visitor with no session to sign in, showing nothing", async () => {
    expect(await pageOutcome(await load("src/app/choose-family/page.tsx"))).toMatchObject({ redirect: expect.stringMatching(/^\/sign-in/) });
  });

  it("the offline page is the same file for everyone, with no family data", () => {
    const html = readFileSync(path.join(root, "public/offline.html"), "utf8").toLowerCase();
    expect(markers().filter((m) => html.includes(m.toLowerCase()))).toEqual([]);
  });
});
