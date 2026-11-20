import { describe, it, expect, beforeAll } from "vitest";
import { asParent, asParentChoosing, asRefusedParent, pageOutcome, type Page, type PageOutcome } from "../helpers/signed-in";
import { readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { resetDb } from "../helpers/db";
import { moneyMarkers, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { familyRecord, studentRecord } from "../helpers/volunteer";

/**
 * The gate every parent page passes through: one family never sees another's data.
 *
 * Every page.tsx (and layout.tsx) under src/app/(parent)/ is found on disk and rendered as family A's parent, then as
 * family B's. The output must hold none of the other family's markers (names, QuickBooks ids, email addresses, phone
 * numbers, the portal's own ids: see tests/helpers/parent.ts) and must show something of the family it was rendered
 * for, so a page that renders an empty state can't pass by showing nothing. Each page is also asked for with no
 * session and with no family chosen, and must send the visitor away itself, with its own address to come back to.
 *
 * A new page needs nothing here unless:
 *  - it has a dynamic segment: give its params in PARAMS (the test says so when one is missing);
 *  - it shows nothing about the family: say why in NO_FAMILY_DATA;
 *  - it shows data the two families don't have yet (invoices, forms): seed it for both in seedTwoFamilies() and add
 *    its recognizable strings to each family's markers.
 */
const root = path.resolve(__dirname, "../..");
const PARENT_DIR = "src/app/(parent)";

/** "src/app/(parent)/students/[id]/page.tsx" is the route "/students/[id]": route groups in (parentheses) are not part of the address. */
const routeOf = (file: string) => {
  const segments = file.slice(PARENT_DIR.length + 1).split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s));
  return `/${segments.join("/")}`;
};
const found = readdirSync(path.join(root, PARENT_DIR), { recursive: true }).map((f) => `${PARENT_DIR}/${String(f).replaceAll("\\", "/")}`);
const pages = found.filter((f) => /\/page\.(tsx|ts|jsx|js)$/.test(f)).map((file) => ({ file, route: routeOf(file) })).sort((a, b) => a.route.localeCompare(b.route));
const layouts = found.filter((f) => /\/layout\.(tsx|ts|jsx|js)$/.test(f)).map((file) => ({ file, route: routeOf(file) }));
const isDynamic = (route: string) => route.includes("[");

/**
 * For a page with a dynamic segment: the params that ask for something belonging to this family. The test renders the
 * page with the viewer's own params (it must show the family's data) and with the other family's (it must not).
 *   "/students/[id]": (family) => ({ id: family.spec.students[0]!.qboId }),
 */
const PARAMS: Record<string, (family: SeededParent) => Record<string, string | string[]>> = {
  // The shift both families are signed up for: the page shows its count and the viewer's own sign-up, never the other's.
  "/volunteer/shifts/[id]": (family) => ({ id: family.volunteer!.shiftId }),
  // The check-in code of the shift both families are on: the page shows the family's own people on it, never the other's.
  "/volunteer/check-in/[code]": (family) => ({ code: family.volunteer!.code }),
  // The family's own request for a form that is signed and finished: its page shows what is stored, and asks Documenso nothing.
  "/forms/[id]": (family) => ({ id: family.forms!.ids.complete }),
  // The link mailed to the address the parent asked to change to: their own pending request. Opening it changes nothing.
  "/family/email/[token]": (family) => ({ token: family.emailChange!.token }),
  // The family's own volunteer requirement with a buy-out: its page shows the buy-out's state and amount, never the other's.
  "/volunteer/pay-instead/[requirementId]/[choice]": (family) => ({ requirementId: family.buyout!.requirementId, choice: family.buyout!.key }),
};

/** Pages that show nothing about the family, and why. Everything else must show at least one of its own family's markers. */
const NO_FAMILY_DATA: Record<string, string> = {
  "/display": "Display settings kept on the device, and the sign-out button.",
};

/** What a page must show its own family, beyond "something": the exact words. */
const MUST_SHOW: Record<string, (family: SeededParent) => string[]> = {
  // The greeting, the roster, and what the family owes now (what it has paid is on the Payments page).
  // And the season ruler with the step the family is on, and what that step asks of it.
  "/": (family) => [`Hi, ${family.spec.parent.name.split(" ")[0]}`, ...rosterOf(family), ...moneyMarkers(family.spec, "open"), ...family.season!.home],
  "/family": (family) => rosterOf(family),
  // The family's name, every invoice's number and amount, the total, and the address behind the Pay button.
  "/payments": (family) => [family.spec.family.name, ...moneyMarkers(family.spec)],
  // Every step of the current season, the family's own requirements among them, and its students by name.
  "/season": (family) => [family.spec.family.name, ...family.spec.students.map((s) => s.name), ...family.season!.page],
  // The event both families signed up for, the one count every family sees, and the family's own sign-up.
  "/volunteer": (family) => [family.spec.family.name, ...family.volunteer!.page, ...family.buyout!.page],
  // The family's own buy-out: the requirement and where it stands, A's invoiced and B's paid.
  "/volunteer/pay-instead/[requirementId]/[choice]": (family) => family.buyout!.page,
  // The shift, the one count every family sees, and who from the family is on it (found by the app's own records).
  "/volunteer/shifts/[id]": (family) => ["2 of 4 places filled", "Rinse crew", ...family.volunteer!.shift],
  // The shift, the family's name, and its own person on it, checked in or not.
  "/volunteer/check-in/[code]": (family) => ["Rinse crew", family.spec.family.name, ...family.volunteer!.checkIn],
  // Every form the season asks of the family and of each student, each with its state in words.
  // And the way to each of its own requests that can be opened, in every state a document has reached, and the download
  // of its signed one: found by the family's own app records, so a page that found none fails here.
  "/forms": (family) => [family.spec.family.name, ...family.spec.students.map((s) => s.name), ...family.forms!.page,
    ...(["waiting", "signed", "complete", "declined", "waitingOther"] as const).map((s) => `href="/forms/${family.forms!.ids[s]}"`), `href="/forms/${family.forms!.ids.complete}/signed"`],
  // One form: its title, the student it is for, and that it is signed.
  // The question a link puts, with the address it would change to, and the address the parent signs in with now.
  "/family/email/[token]": (family) => [`Use ${family.emailChange!.newEmail} to sign in from now on?`, family.spec.parent.email],
  // The address the parent signs in with now, and, since the sign-in release's slice SI-5a, what comes before the new
  // address: the seeded parents have no password yet, so the offer of a link to choose one.
  "/family/email": (family) => [family.spec.parent.email, "Email me a link to choose a password"],
  "/forms/[id]": (family) => ["Uniform agreement", family.spec.students[1]!.name, "nothing more to do for this form", `${family.spec.parent.name} (you)`],
};
/** The family as the roster cache has it: its name, its students, and the parent's own name, address and number. */
function rosterOf(family: SeededParent): string[] {
  const { spec } = family;
  return [spec.family.name, ...spec.students.map((s) => s.name), spec.parent.name, spec.parent.email, spec.parent.phone];
}

const load = async (file: string): Promise<Page> => ((await import(path.join(root, file))) as { default: Page }).default;
const missingParams = (route: string) => `The parent page ${route} has a dynamic segment and no params to render it with. `
  + `Add it to PARAMS in tests/integration/parent-isolation.test.ts, for example "/students/[id]": (family) => ({ id: family.spec.students[0]!.qboId }).`;
const paramsFor = (route: string, family: SeededParent) => {
  if (!isDynamic(route)) return undefined;
  const params = PARAMS[route];
  if (!params) expect.fail(missingParams(route));
  return params(family);
};
/** The page's address as a browser asks for it: "/students/[id]" with { id: "12" } is "/students/12". */
const addressOf = (route: string, params: Record<string, string | string[]> = {}) =>
  route.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (_all, name: string) => [params[name] ?? ""].flat().join("/"));
/**
 * Where a page's guard sends a visitor: the sign-in page (or the chooser), carrying this page's own address so the
 * parent is brought back to it afterward (requireParentPage(returnTo) in src/lib/guards.ts). Never another page's.
 * The home page carries none: everyone lands there anyway.
 */
const awayTo = (to: "/sign-in" | "/choose-family", address: string) => (address === "/" ? to : `${to}?next=${encodeURIComponent(address)}`);
const markersIn = (html: string, markers: string[]) => { const text = html.toLowerCase(); return markers.filter((m) => text.includes(m.toLowerCase())); };
const describeOutcome = (o: PageOutcome) => ("html" in o ? "rendered" : "redirect" in o ? `redirected to ${o.redirect}` : "answered 404");

describe("one family never sees another's data on a parent page", () => {
  let a: SeededParent, b: SeededParent;
  beforeAll(async () => { await resetDb(); ({ a, b } = await seedTwoFamilies()); });

  it("finds the parent pages on disk", () => {
    expect(pages.map((p) => p.route)).toEqual(expect.arrayContaining(["/", "/display"]));
    expect(layouts.map((l) => l.file)).toContain(`${PARENT_DIR}/layout.tsx`);
  });

  it("has params for every page with a dynamic segment, and no entry for a page that is gone", () => {
    const missing = pages.filter((p) => isDynamic(p.route) && !PARAMS[p.route]).map((p) => p.route);
    expect(missing, missing.map(missingParams).join(" ")).toEqual([]);
    const routes = pages.map((p) => p.route);
    for (const [name, map] of [["PARAMS", PARAMS], ["NO_FAMILY_DATA", NO_FAMILY_DATA], ["MUST_SHOW", MUST_SHOW]] as const) {
      const gone = Object.keys(map).filter((route) => !routes.includes(route));
      expect(gone, `${name} names pages that no longer exist: ${gone.join(", ")}. Remove them.`).toEqual([]);
    }
  });

  describe.each(pages)("$route ($file)", ({ file, route }) => {
    it.each([["family A's parent sees nothing of family B", "a"], ["family B's parent sees nothing of family A", "b"]] as const)("%s, and sees their own family", async (_name, who) => {
      const [viewer, other] = who === "a" ? [a, b] : [b, a];
      const page = await load(file);
      asParent(viewer.identity);
      const outcome = await pageOutcome(page, { params: paramsFor(route, viewer) });
      if (!("html" in outcome)) {
        expect.fail(`${file} ${describeOutcome(outcome)} for a signed-in parent asking for their own family${isDynamic(route) ? " (check its params in PARAMS)" : ""}; it must render.`);
      }
      const leaked = markersIn(outcome.html, other.markers);
      expect(leaked, `${file}, rendered for ${viewer.spec.family.name}, contains data of ${other.spec.family.name}: ${leaked.join(", ")}. `
        + `Every query on a parent page takes the family from ctx.familyId (the session), never from the URL or a form.`).toEqual([]);

      const own = markersIn(outcome.html, viewer.markers);
      if (route in NO_FAMILY_DATA) {
        expect(own, `${file} is listed in NO_FAMILY_DATA but shows ${own.join(", ")}. Remove it from NO_FAMILY_DATA so the test checks what it shows.`).toEqual([]);
      } else if (own.length === 0) {
        expect.fail(`${file}, rendered for ${viewer.spec.family.name}, shows nothing that belongs to that family, so this test can't tell whether it would show another family's. `
          + `If the page shows data the fixture doesn't have yet, seed it for both families in seedTwoFamilies() (tests/helpers/parent.ts) and add its strings to the markers. `
          + `If the page shows nothing about the family, add it to NO_FAMILY_DATA with the reason.`);
      }
      for (const words of MUST_SHOW[route]?.(viewer) ?? []) expect(outcome.html, `${file} for ${viewer.spec.family.name}`).toContain(words);
      // What staff wrote for staff (a waiver's reason) reaches no parent page, the family's own included.
      for (const words of viewer.season!.staffOnly) expect(outcome.html, `${file} shows ${viewer.spec.family.name} a note that is for staff only`).not.toContain(words);
    });

    it.runIf(isDynamic(route))("shows nothing when asked for the other family's ids in the address", async () => {
      const page = await load(file);
      for (const [viewer, other] of [[a, b], [b, a]] as const) {
        asParent(viewer.identity);
        const outcome = await pageOutcome(page, { params: paramsFor(route, other) });
        if (!("html" in outcome)) continue; // a 404 or a redirect: nothing shown
        const leaked = markersIn(outcome.html, other.markers);
        expect(leaked, `${file}, asked by ${viewer.spec.family.name} for ${other.spec.family.name}'s ids in the address, shows: ${leaked.join(", ")}. `
          + `An id from the URL is untrusted: look it up within ctx.familyId and answer notFound() when it isn't there.`).toEqual([]);
      }
    });

    it("sends a visitor with no session to /sign-in, and one with no family chosen to /choose-family", async () => {
      const page = await load(file);
      const props = { params: paramsFor(route, a) };
      // Every test starts signed out (tests/helpers/signed-in.ts).
      const address = addressOf(route, props.params);
      const anonymous = await pageOutcome(page, props);
      expect(anonymous, `${file} ${describeOutcome(anonymous)} for a visitor with no session; it must call requireParentPage() itself, before anything else, with its own address (${address}).`).toEqual({ redirect: awayTo("/sign-in", address) });
      asParentChoosing(a.identity);
      const choosing = await pageOutcome(page, props);
      expect(choosing, `${file} ${describeOutcome(choosing)} for a parent who has not chosen a family; it must call requireParentPage() itself, before anything else, with its own address (${address}).`).toEqual({ redirect: awayTo("/choose-family", address) });
      asRefusedParent();
      const refused = await pageOutcome(page, props);
      expect(refused, `${file} ${describeOutcome(refused)} for a session the portal refuses; it must call requireParentPage() itself, before anything else.`).toEqual({ redirect: "/refused" });
    });
  });

  // A form's page for each of the family's own requests, in every state, found by the family's own app records: it
  // renders, shows its form, and nothing of the other family; asked for the other family's request in any state, or its
  // app family or student ids, it shows nothing of theirs.
  it("shows each of the family's own forms in every state, and nothing of the other family's in any", async () => {
    const page = await load(`${PARENT_DIR}/forms/[id]/page.tsx`);
    for (const [viewer, other] of [[a, b], [b, a]] as const) {
      asParent(viewer.identity);
      for (const [state, id] of Object.entries(viewer.forms!.ids)) {
        const outcome = await pageOutcome(page, { params: { id } });
        if (!("html" in outcome)) expect.fail(`/forms/${state} ${describeOutcome(outcome)} for ${viewer.spec.family.name}'s own request; it must render.`);
        expect(markersIn(outcome.html, other.markers), `/forms/[id] (${state}) for ${viewer.spec.family.name}`).toEqual([]);
        expect(markersIn(outcome.html, [id]).length + markersIn(outcome.html, viewer.markers).length, `/forms/[id] (${state}) shows nothing of its own family`).toBeGreaterThan(0);
        for (const words of viewer.season!.staffOnly) expect(outcome.html).not.toContain(words);
      }
      const theirRecords = [String(await familyRecord(other.spec.family.qboId)), ...(await Promise.all(other.spec.students.map(async (s) => String(await studentRecord(s.qboId)))))];
      for (const id of [...Object.values(other.forms!.ids), ...theirRecords]) {
        const outcome = await pageOutcome(page, { params: { id } });
        if ("html" in outcome) expect(markersIn(outcome.html, other.markers), `/forms/${id} for ${viewer.spec.family.name}`).toEqual([]);
      }
    }
  });

  // What surrounds every parent page is sent to the same browser, so it passes the same gate.
  describe.each(layouts)("the layout $file", ({ file }) => {
    it.each([["family A's parent sees nothing of family B", "a"], ["family B's parent sees nothing of family A", "b"]] as const)("%s", async (_name, who) => {
      const [viewer, other] = who === "a" ? [a, b] : [b, a];
      asParent(viewer.identity);
      const outcome = await pageOutcome(await load(file), { children: createElement("main", null, "the page") });
      if (!("html" in outcome)) expect.fail(`${file} ${describeOutcome(outcome)} for a signed-in parent; it must render.`);
      expect(outcome.html).toContain("the page");
      const leaked = markersIn(outcome.html, other.markers);
      expect(leaked, `${file}, rendered for ${viewer.spec.family.name}, contains data of ${other.spec.family.name}: ${leaked.join(", ")}.`).toEqual([]);
    });
  });
});
