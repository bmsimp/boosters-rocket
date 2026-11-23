import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";
import { parentSessionCookie } from "./parent-session";
import { staffSessionCookie } from "./staff-session";
import { E2E_MESSAGE } from "./messages-seed";

/**
 * Club messages end to end (docs/superpowers/specs/2026-11-23-club-messages-design.md, section 13), on a phone and on a
 * laptop: the seeded Admin (scripts/seed-e2e.ts, also E2E_MESSAGE's poster) posts a message with "Also email families"
 * ticked; Zelda sees it on Home, opens it (it is read for her), and opens the poster's profile; the Admin edits it and
 * Zelda sees "Edited" and its earlier version; the Admin deletes it and Zelda's link to it is "not found". Each page is
 * checked with axe (WCAG 2.0 to 2.2, A and AA; contrast is parent-a11y.spec.ts's, in every display mode) and for
 * sideways scrolling.
 *
 * Both passes read one seed, so each posts a message of its own, by a title naming its pass, and leaves the seed as it
 * found it: the club's email switch is turned on for the spec and put back, and the message, deleted by the journey
 * itself, is removed with anything a pass cut off midway left. The seeded message is never opened, so Zelda's read of
 * it is as the seed left it: Home is checked only for this pass's message.
 */
const sql = postgres(process.env.DATABASE_URL!);
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const SWITCH = "messages.email_allowed";

let switchBefore: unknown;
let made: string | null = null;
test.beforeAll(async () => {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM setting WHERE key = ${SWITCH}`;
  switchBefore = row?.value;
  await sql`INSERT INTO setting (key, value) VALUES (${SWITCH}, ${sql.json({ emailAllowed: true })})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
});
test.afterEach(async () => {
  if (made) await removeMessage(made);
  made = null;
});
test.afterAll(async () => {
  if (switchBefore === undefined) await sql`DELETE FROM setting WHERE key = ${SWITCH}`;
  else await sql`UPDATE setting SET value = ${sql.json(switchBefore as Parameters<typeof sql.json>[0])} WHERE key = ${SWITCH}`;
  await sql.end();
});

/** Everything of one message, whatever state a pass left it in: its reads and mail go with it (on delete cascade). */
async function removeMessage(id: string) {
  await sql`DELETE FROM message_version WHERE message_id = ${id}`;
  await sql`DELETE FROM message_file WHERE message_id = ${id}`;
  await sql`DELETE FROM message WHERE id = ${id}`;
}

async function signedIn(browser: Browser, who: "staff" | "parent", baseURL: string | undefined, viewport: { width: number; height: number } | null): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: viewport ?? undefined });
  await context.addCookies([who === "staff" ? staffSessionCookie() : parentSessionCookie()]);
  return context.newPage();
}

async function checked(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${where} scrolls sideways`).toBe(false);
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).disableRules(["color-contrast"]).analyze();
  expect(results.violations.flatMap((v) => v.nodes.map((n) => `${where} · ${n.target.join(" ")}: ${v.id} (${v.help})`))).toEqual([]);
}

/** The body editor, there once the form has drawn it in the browser: typing before then could be lost. */
const editorOf = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });

test("staff post a message with its email, a parent reads it and its poster's profile, the poster edits it, and an Admin deletes it", async ({ browser, baseURL, viewport }, info) => {
  const title = `Bus times for the away game (${info.project.name})`;
  const edited = `Bus times for the away game, changed (${info.project.name})`;
  const staff = await signedIn(browser, "staff", baseURL, viewport);
  const parent = await signedIn(browser, "parent", baseURL, viewport);

  // --- staff post it, the box ticked ---------------------------------------------------------------------------------
  expect((await staff.goto("/staff/messages/new"))?.status()).toBe(200);
  await expect(editorOf(staff)).toBeVisible();
  await staff.getByLabel("Title", { exact: true }).fill(title);
  // A title alone isn't a message: the body needs some words or a picture.
  await staff.getByRole("button", { name: "Post", exact: true }).click();
  await expect(staff.getByText("Add a few words or a picture to the message.")).toBeVisible();
  await expect(staff).toHaveURL(/\/staff\/messages\/new$/);
  await editorOf(staff).click();
  await staff.keyboard.type("The bus leaves the school at 3:15.");
  // The toolbar's buttons work on what is written, and say when they are on.
  await staff.keyboard.press("Enter");
  const bullets = staff.getByRole("button", { name: "Bulleted list", exact: true });
  await bullets.click();
  await expect(bullets).toHaveAttribute("aria-pressed", "true");
  await staff.keyboard.type("Bring water.");
  const box = staff.getByRole("checkbox", { name: "Also email families" });
  await expect(box).toBeChecked();
  // The editor is what staff see (no Preview): beside the box, how many addresses the email goes to.
  await expect(staff.getByText(/^Goes to \d+ address(es)?\./)).toBeVisible();
  await expect(staff.getByText(/^This goes to \d+ famil(y|ies)\.$/)).toBeVisible();
  await expect(staff.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
  await checked(staff, "/staff/messages/new");
  await staff.getByRole("button", { name: "Post", exact: true }).click();
  await expect(staff).toHaveURL(/\/staff\/messages\/[0-9a-f-]{36}$/);
  const id = new URL(staff.url()).pathname.split("/").pop()!;
  made = id;
  await expect(staff.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(staff.locator(".msg-body li").first()).toHaveText("Bring water.");
  // Its email is queued for every parent who can sign in, Zelda among them; staff see how far it has got.
  const [queued] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM message_mail m JOIN message_version v ON v.id = m.version_id
                                               WHERE v.message_id = ${id} AND m.address = 'zelda@example.com'`;
  expect(queued!.n).toBe(1);
  await expect(staff.getByRole("heading", { name: /^Version 1: (Emailing|Emailed)/ })).toBeVisible();
  await checked(staff, "/staff/messages/[id]");

  // --- a parent sees it on Home, opens it, and it is read --------------------------------------------------------
  expect((await parent.goto("/"))?.status()).toBe(200);
  const card = parent.locator(".home-messages");
  await expect(card.getByRole("heading", { name: /^\d+ new messages? from the club$/ })).toBeVisible();
  await expect(card.getByRole("link", { name: title })).toBeVisible();
  await checked(parent, "/ (Home), a new message");
  await card.getByRole("link", { name: /^Read (it|them) in Messages$/ }).click();
  await expect(parent).toHaveURL(/\/messages$/);
  const row = parent.locator(".list-row").filter({ hasText: title });
  await expect(row).toContainText("New");
  await expect(row).toContainText("Posted by E2E Admin");
  await checked(parent, "/messages");
  await row.getByRole("link").click();
  await expect(parent).toHaveURL(new RegExp(`/messages/${id}$`));
  await expect(parent.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(parent.locator("main")).toContainText("The bus leaves the school at 3:15.");
  await expect(parent.locator("main")).toContainText("Posted by E2E Admin");
  await expect(parent.locator("main")).not.toContainText("Edited");
  await checked(parent, "/messages/[id]");
  await parent.goto("/messages");
  await expect(parent.locator(".list-row").filter({ hasText: title })).not.toContainText("New");
  await parent.goto("/");
  await expect(parent.locator("main")).not.toContainText(title);

  // --- the poster's profile ----------------------------------------------------------------------------------------
  await parent.goto(`/messages/${id}`);
  await parent.getByRole("link", { name: "E2E Admin", exact: true }).click();
  await expect(parent).toHaveURL(new RegExp(`/messages/from/${E2E_MESSAGE.posterId}$`));
  await expect(parent.getByRole("heading", { level: 1 })).toHaveText("E2E Admin");
  await expect(parent.getByRole("link", { name: "e2e-admin@example.org" })).toHaveAttribute("href", "mailto:e2e-admin@example.org");
  await expect(parent.locator(".list-row").filter({ hasText: title })).toBeVisible();
  await checked(parent, "/messages/from/[staffId]");

  // --- the poster edits it ---------------------------------------------------------------------------------------
  await staff.goto(`/staff/messages/${id}`);
  await staff.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(staff).toHaveURL(new RegExp(`/staff/messages/${id}/edit$`));
  await expect(editorOf(staff)).toContainText("The bus leaves the school at 3:15.");
  await staff.getByLabel("Title", { exact: true }).fill(edited);
  await editorOf(staff).click();
  await staff.keyboard.press("ControlOrMeta+A");
  await staff.keyboard.type("The bus now leaves the school at 2:45.");
  await expect(staff.getByRole("checkbox", { name: "Email families about this change" })).toBeChecked();
  await checked(staff, "/staff/messages/[id]/edit");
  await staff.getByRole("button", { name: "Save changes" }).click();
  await expect(staff).toHaveURL(new RegExp(`/staff/messages/${id}$`));
  await expect(staff.getByRole("heading", { level: 1 })).toHaveText(edited);
  await expect(staff.getByRole("heading", { name: "Earlier versions" })).toBeVisible();

  // --- the parent sees "Edited" and the earlier version ------------------------------------------------------------
  await parent.goto("/messages");
  // An emailed edit makes it new again.
  await expect(parent.locator(".list-row").filter({ hasText: edited })).toContainText("New");
  await parent.goto(`/messages/${id}`);
  await expect(parent.getByRole("heading", { level: 1 })).toHaveText(edited);
  await expect(parent.locator("main")).toContainText("The bus now leaves the school at 2:45.");
  await expect(parent.locator("main")).toContainText("Edited");
  await expect(parent.getByRole("heading", { name: "Earlier versions" })).toBeVisible();
  const earlier = parent.locator("details").filter({ hasText: "Version 1" });
  await earlier.locator("summary").click();
  await expect(earlier.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(earlier).toContainText("The bus leaves the school at 3:15.");
  await checked(parent, "/messages/[id], edited");

  // --- an Admin deletes it; the parent's link finds nothing --------------------------------------------------------
  await staff.goto(`/staff/messages/${id}`);
  await staff.getByRole("button", { name: "Delete message" }).click();
  await expect(staff.getByText(/^Delete this message\?/)).toBeVisible();
  await checked(staff, "/staff/messages/[id], asking to delete");
  await staff.getByRole("button", { name: "Yes, delete it" }).click();
  // The page is drawn again as the deleted message's: its line is a Notice, which starts with its tone's word ("Note").
  await expect(staff.getByRole("heading", { level: 1 })).toHaveText("Deleted message");
  await expect(staff.locator(".notice").filter({ hasText: /Deleted by E2E Admin on / })).toBeVisible();
  const [left] = await sql<{ versions: number; mail: number }[]>`SELECT
      (SELECT count(*)::int FROM message_version WHERE message_id = ${id}) AS versions,
      (SELECT count(*)::int FROM message_mail m JOIN message_version v ON v.id = m.version_id WHERE v.message_id = ${id}) AS mail`;
  expect(left).toEqual({ versions: 0, mail: 0 });
  expect((await parent.goto(`/messages/${id}`))?.status()).toBe(404);
  await parent.goto("/messages");
  await expect(parent.locator("main")).not.toContainText("Bus times for the away game");

  await staff.context().close();
  await parent.context().close();
});
