import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, setting, student, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { KEPT_GONE, keptOnLinksOf, loadAccountingLinks, readLinkBasics, type KeptOffer, type LinkRow, type LinksView } from "@/lib/accounting/mapping";
import { loadOpenWrites } from "@/lib/roster/queue";
import { refreshRoster } from "@/lib/roster/refresh";
import { SHAPE_KEY } from "@/lib/roster/shape";
import { CONTACT_DIFFERS, EMAIL_DIFFERS, KEPT_OFF_STAYS, portalValueStamp, sendToBooks } from "@/lib/roster/writes";
import { giveUpAction, sendPortalValueAction } from "@/app/staff/(app)/roster/write-actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import { resetDb } from "../helpers/db";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { auditsOf, connectRoster, queueItem, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";
import { unlinkThroughThePress } from "../helpers/links";
import { rowNamed } from "../helpers/table";

/**
 * A change saved in the portal first that didn't go through and is kept (a `refused` item of the write queue), of a
 * field the accounting links screen compares, shown beside its difference there (stage 4's slice M5c; keptOnLinksOf(),
 * src/lib/accounting/mapping.ts) and, by the owner's decision of 2026-11-21, still on Reconciliation's kept list with
 * its own presses: settled from either page, it reads settled on the other. The company is fznCompany()'s
 * (tests/helpers/qbo-stub.ts): Rivera Family 10 with Ana Rivera 11 (Parent) and Leo Rivera 12 (Student), Chen Family 20
 * with Mei Chen 21 (Parent). The books change only through the stub (changeInBooks(), with a roster read, readAgain()).
 */
vi.setConfig({ testTimeout: 60_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
async function readAgain() {
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };
const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const section = (html: string, id: string) => { const at = html.indexOf(`id="${id}"`); return at < 0 ? "" : decode(html.slice(at, html.indexOf("</section>", at))); };
const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
const ALSO_BESIDE = "It is also shown on Accounting links, in its family's row, beside its difference: sent or given up on either page, it is settled on both.";
const ALSO_GONE = "It is also shown on Accounting links, in its family's row, where the books' copy shows no difference for it now: sent or given up on either page, it is settled on both.";
const ALSO_INACTIVE = "It is also shown on Accounting links, with its family under Inactive in the portal, active in the books: sent or given up on either page, it is settled on both.";
const ALSO = "It is also shown on Accounting links";
const REFUSED = "QuickBooks refused it: QuickBooks wouldn't take it.";
const GIVE_UP = '<details class="more"><summary>Give up</summary><p class="hint">The portal keeps its own value, and QuickBooks keeps what it has.</p>';

let tag: string;
let full: Awaited<ReturnType<typeof staffWith>>, reader: Awaited<ReturnType<typeof staffWith>>;
const op = () => ({ actor: { door: "staff" as const, id: full.id, label: full.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: full.id });
let rivera: AppFamilyId, chen: AppFamilyId, leo: AppStudentId;
let anaRow: Awaited<ReturnType<typeof seedAnaRivera>>["row"];

beforeEach(async () => {
  await resetDb(); stub.reset();
  stub.quirks.balances = true;
  full = await staffWith("full@club.org", ["Roster.Read", "Accounting.Link.ReadWrite", "Roster.Family.ReadWrite"]);
  reader = await staffWith("reader@club.org", ["Roster.Read"]);
});
async function layered() {
  tag = await connectRoster(stub);
  ({ row: anaRow } = await seedAnaRivera());
  [rivera, chen, leo] = [await recordOfCustomer("10", "family"), await recordOfCustomer("20", "family"), await recordOfCustomer("12", "student")];
}
/** Flat books whose Rivera Family has nobody under it. */
async function flat() {
  const company = fznCompany();
  tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] }, company: { ...company, customers: company.customers.filter((c) => c.Id !== "11" && c.Id !== "12") } });
  rivera = await recordOfCustomer("10", "family");
}
const keptRenameOfRivera = (role: "family" | "member" = "family", code = "fault_6000") =>
  seedQueued({ op: "rename", role, qboId: "10", syncToken: "0", name: "Rivera Family", was: "Rivera Old" }, { state: "refused", code, nextTryAt: null, familyId: rivera });
const RIVERA_WORDS = `Kept in the portal: Rename the family “Rivera Old” to “Rivera Family”. ${REFUSED}`;
const keptOffersOf = async (name: string) => rowOf(await loadAccountingLinks({ mayChange: true }), name).kept;
const writes = async (who: { id: string; name: string; email: string }, sp: Record<string, string> = {}) => { asStaff(who); return section(await renderPage(ReconciliationPage, { searchParams: sp }), "writes-h"); };
const linksList = async (who: { id: string; name: string; email: string } = full) => { asStaff(who); return section(await renderPage(AccountingLinksPage), "links-list-h"); };

describe("shown beside its difference, and still on Reconciliation", () => {
  beforeEach(layered);

  it("a kept rename of a linked family: once, in words, Give up beside Take and Send; on Reconciliation whole, with one line saying where else it is", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    await readAgain();
    const kept = await keptRenameOfRivera();
    const row = rowOf(await loadAccountingLinks({ mayChange: true }), "Rivera Family");
    const at = row.differences.findIndex((d) => d.kind === "name");
    expect(row.kept).toEqual([{ at, itemId: kept.id, words: RIVERA_WORDS, giveUp: true } satisfies KeptOffer]);
    // Its Send and Take are offered (a kept note stops neither), and the Send's words say it closes the kept change.
    expect(row.sends.find((s) => s.at === at)?.words).toContain("The rename kept on the Reconciliation page is closed, as this takes its place.");
    expect(row.takes.map((t) => t.at)).toContain(at);
    // A reader who may not change families is shown the words but no Give up.
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").kept).toEqual([expect.objectContaining({ itemId: kept.id, giveUp: false })]);

    const list = await linksList();
    expect(list.split(RIVERA_WORDS)).toHaveLength(2);
    // In place of the queue's note, so not linked to Reconciliation for it, and Give up in the same row-actions as Take and Send.
    expect(list).not.toContain("See the change on Reconciliation");
    expect(list).toContain(`Send the app's to QuickBooks<span class="visually-hidden">: Rivera Family's name</span></button>${GIVE_UP}`);
    expect(list).toContain("Why? (kept in the audit log)");
    // No item id and no stamp is drawn: the presses are bound actions given only their words.
    expect(list).not.toContain(kept.id);
    for (const s of [...row.sends, ...row.takes]) expect(list).not.toContain(s.stamp);

    const recon = await writes(full);
    expect(recon).toContain("Not in QuickBooks, kept in the portal (1)");
    expect(recon).toContain("Rename the family “Rivera Old” to “Rivera Family”");
    expect(recon).toContain("Send the portal's value");
    expect(recon).toContain(ALSO_BESIDE);
    expect(recon).toContain('href="/staff/links#links-list-h">See it on Accounting links');
    // A Roster.Read reader: the same line, and who settles it there, with no link to a page they can't open.
    const read = await writes(reader);
    expect(read).toContain(ALSO_BESIDE);
    expect(read).toContain("Someone who may link families to accounting sees it there.");
    expect(read).not.toContain("/staff/links");
    expect(read).not.toContain("Give up");
  });

  it("a kept rename of a student, a kept move of a student and a kept make-inactive of a student QuickBooks refused: each on its difference in its family's row", async () => {
    changeInBooks("12", { DisplayName: "Leo M. Rivera", SyncToken: "1" });
    await readAgain();
    const rename = await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leo Rivera", was: "Leo M. Rivera" }, { state: "refused", code: "fault_6000", nextTryAt: null });
    let row = rowOf(await loadAccountingLinks({ mayChange: true }), "Rivera Family");
    expect(row.kept).toEqual([{ at: row.differences.findIndex((d) => d.kind === "name" && d.of === "student"), itemId: rename.id,
      words: `Kept in the portal: Rename the student “Leo M. Rivera” to “Leo Rivera”. ${REFUSED}`, giveUp: true }]);
    await db.delete(writeQueue);

    // Leo under Chen in the books, in Rivera in the portal: the kept move on the Rivera row's place, not on Chen's row.
    changeInBooks("12", { DisplayName: "Leo Rivera", ...under("20"), SyncToken: "2" });
    await readAgain();
    const move = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "2", fromFamilyQboId: "20", toFamilyQboId: "10", fromFamilyId: chen, toFamilyId: rivera },
      { state: "refused", code: "fault_6000", nextTryAt: null });
    const view = await loadAccountingLinks({ mayChange: true });
    row = rowOf(view, "Rivera Family");
    expect(row.kept).toEqual([expect.objectContaining({ at: row.differences.findIndex((d) => d.kind === "place"), itemId: move.id })]);
    expect(rowOf(view, "Chen Family").kept).toEqual([]);
    expect(row.sends.find((s) => s.field === "place")?.words).toContain("The move kept on the Reconciliation page is closed, as this takes its place.");
    await db.delete(writeQueue);

    // Leo inactive in the portal, active in the books, under Rivera again: the kept make-inactive on his active difference.
    changeInBooks("12", { ...under("10"), SyncToken: "3" });
    await readAgain();
    await db.update(student).set({ active: false }).where(eq(student.id, leo));
    const off = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { state: "refused", code: "fault_6000", nextTryAt: null });
    row = rowOf(await loadAccountingLinks({ mayChange: true }), "Rivera Family");
    const at = row.differences.findIndex((d) => d.kind === "active");
    expect(row.kept).toEqual([{ at, itemId: off.id, words: `Kept in the portal: Make the student Leo Rivera inactive. ${REFUSED}`, giveUp: true }]);
    // Its Take of active leaves it standing, and says so in words true of both pages.
    expect(row.takes.find((t) => t.at === at)?.words).toContain(KEPT_OFF_STAYS);
    const list = await linksList();
    expect(list).toContain(`Send the app's to QuickBooks<span class="visually-hidden">: Leo Rivera's active status</span></button>${GIVE_UP}`);
    expect(await writes(full)).toContain(ALSO_BESIDE);
  });

  it("the books changed to the portal's value after it was kept: on its row as having no difference, with Give up and no Send", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    await readAgain();
    const kept = await keptRenameOfRivera();
    changeInBooks("10", { DisplayName: "Rivera Family", SyncToken: "2" });
    await readAgain();
    const row = rowOf(await loadAccountingLinks({ mayChange: true }), "Rivera Family");
    expect(row.differences).toEqual([]);
    expect(row.sends).toEqual([]);
    expect(row.kept).toEqual([{ at: null, itemId: kept.id, words: RIVERA_WORDS, giveUp: true }]);
    const opening = decode(rowNamed(await (async () => { asStaff(full); return renderPage(AccountingLinksPage); })(), "Rivera Family")![4]!);
    expect(opening).toContain(`Changes kept in the portal that the books' copy shows no difference for now:${RIVERA_WORDS} ${KEPT_GONE}Give up`);
    expect(opening).not.toContain("Send the app's to QuickBooks");
    expect(await writes(full)).toContain(ALSO_GONE);
  });

  it("family A's row never shows family B's kept item", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    changeInBooks("20", { DisplayName: "Chen Household", SyncToken: "1" });
    await readAgain();
    const ours = await keptRenameOfRivera();
    const theirs = await seedQueued({ op: "rename", role: "family", qboId: "20", syncToken: "0", name: "Chen Family", was: "Chen Old" }, { state: "refused", code: "fault_6000", nextTryAt: null });
    const view = await loadAccountingLinks({ mayChange: true });
    expect(rowOf(view, "Rivera Family").kept.map((k) => k.itemId)).toEqual([ours.id]);
    expect(rowOf(view, "Chen Family").kept.map((k) => k.itemId)).toEqual([theirs.id]);
    asStaff(full);
    const html = await renderPage(AccountingLinksPage);
    expect(decode(rowNamed(html, "Rivera Family")![4]!)).toContain("Rename the family “Rivera Old”");
    expect(decode(rowNamed(html, "Rivera Family")![4]!)).not.toContain("Chen Old");
    expect(decode(rowNamed(html, "Chen Family")![4]!)).not.toContain("Rivera Old");
  });

  it("reads as many times with kept items as with the same items waiting: no query of its own", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    changeInBooks("12", { DisplayName: "Leo M. Rivera", SyncToken: "1" });
    await readAgain();
    await db.update(student).set({ active: false }).where(eq(student.id, leo));
    await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Rivera Family", was: "Rivera Old" }, { state: "waiting" });
    await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { state: "waiting" });
    const spy = vi.spyOn(db, "select");
    try {
      await loadAccountingLinks({ mayChange: true });
      const waiting = spy.mock.calls.length;
      await db.update(writeQueue).set({ state: "refused", lastCode: "fault_6000", nextTryAt: null });
      spy.mockClear();
      const view = await loadAccountingLinks({ mayChange: true });
      expect(rowOf(view, "Rivera Family").kept).toHaveLength(2);
      expect(spy.mock.calls.length).toBe(waiting);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("flat books: a member", () => {
  beforeEach(flat);

  it("a kept rename of a member on its difference; a kept make-inactive of an inactive member on the inactive list, beside its Take and Send", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    await readAgain();
    const rename = await keptRenameOfRivera("member");
    const row = rowOf(await loadAccountingLinks({ mayChange: true }), "Rivera Family");
    expect(row.kept).toEqual([{ at: row.differences.findIndex((d) => d.kind === "name"), itemId: rename.id,
      words: `Kept in the portal: Rename the member “Rivera Old” to “Rivera Family”. ${REFUSED}`, giveUp: true }]);
    await db.delete(writeQueue);

    await db.update(family).set({ active: false }).where(eq(family.id, rivera));
    const off = await seedQueued({ op: "deactivate", role: "member", qboId: "10", syncToken: "1" }, { state: "refused", code: "fault_6000", nextTryAt: null });
    const view = await loadAccountingLinks({ mayChange: true });
    const inactive = view.inactive.find((r) => r.name === "Rivera Family")!;
    expect(inactive.kept).toEqual({ at: null, itemId: off.id, words: expect.stringContaining("Kept in the portal: Make the member Rivera Household inactive."), giveUp: true });
    expect(inactive.send).not.toBeNull();
    expect(inactive.take?.words).toContain(KEPT_OFF_STAYS);
    asStaff(full);
    const part = section(await renderPage(AccountingLinksPage), "links-inactive-h");
    expect(part).toContain("Kept in the portal: Make the member Rivera Household inactive.");
    expect(part).toContain(`Send the app's to QuickBooks<span class="visually-hidden">: Rivera Family's active status</span></button>${GIVE_UP}`);
    expect(await writes(full)).toContain(ALSO_INACTIVE);
  });
});

describe("settled from either page, it reads settled on the other", () => {
  beforeEach(async () => {
    await layered();
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    await readAgain();
  });

  it("the difference's Send closes it (roster.write.replaced): Reconciliation lists it no longer", async () => {
    const kept = await keptRenameOfRivera();
    const send = rowOf(await loadAccountingLinks({ mayChange: true }), "Rivera Family").sends.find((s) => s.field === "name")!;
    expect(await sendToBooks({ field: "name", kind: "family", recordId: send.recordId, stamp: send.stamp }, tag, op())).toMatchObject({ ok: true });
    expect(await queueItem(kept.id)).toMatchObject({ state: "given_up" });
    expect((await auditsOf("roster.write.replaced")).map((a) => a.targetId)).toEqual([kept.id]);
    expect(await writes(full)).not.toContain("Not in QuickBooks, kept in the portal");
    expect(await keptOffersOf("Rivera Family")).toEqual([]);
  });

  it("Give up from the screen gives it up (roster.write.given_up), in words true of either page: Reconciliation lists it no longer", async () => {
    const kept = await keptRenameOfRivera();
    asStaff(full);
    const r = await giveUpAction(kept.id, "QuickBooks keeps its name.");
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("Given up. Nothing more will be sent for it. The portal keeps its own name") });
    expect((r as { message: string }).message).not.toContain("this page");
    expect(await auditsOf("roster.write.given_up")).toEqual([expect.objectContaining({ targetId: kept.id, after: { state: "given_up", note: "QuickBooks keeps its name." } })]);
    expect(await writes(full)).not.toContain("Not in QuickBooks, kept in the portal");
    expect(await keptOffersOf("Rivera Family")).toEqual([]);
  });

  it("Send the portal's value or Give up on Reconciliation: the screen shows it no longer", async () => {
    const kept = await keptRenameOfRivera();
    expect(await keptOffersOf("Rivera Family")).toHaveLength(1);
    const [item] = await loadOpenWrites();
    asStaff(full);
    expect(await sendPortalValueAction(kept.id, item!.shown, portalValueStamp(kept.id, item!.shown))).toMatchObject({ ok: true });
    expect((await queueItem(kept.id))!.state).not.toBe("refused");
    expect(await keptOffersOf("Rivera Family")).toEqual([]);
    // A second kept rename, given up there.
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "5" });
    await readAgain();
    const again = await keptRenameOfRivera();
    expect((await keptOffersOf("Rivera Family")).map((k) => k.itemId)).toEqual([again.id]);
    asStaff(full);
    expect(await giveUpAction(again.id, "Not wanted.")).toMatchObject({ ok: true });
    expect(await keptOffersOf("Rivera Family")).toEqual([]);
  });
});

describe("stays on Reconciliation alone, and not on the screen", () => {
  beforeEach(layered);
  /** Every kept offer the screen shows, on its rows and its inactive list. */
  const everyKept = async () => { const v = await loadAccountingLinks({ mayChange: true }); return [...v.rows.flatMap((r) => r.kept), ...v.inactive.flatMap((r) => (r.kept ? [r.kept] : []))]; };
  const notMoved = async () => {
    expect(await everyKept()).toEqual([]);
    expect(keptOnLinksOf(await readLinkBasics(), await loadOpenWrites())).toEqual(new Map());
    const recon = await writes(full);
    expect(recon).toContain("Not in QuickBooks, kept in the portal");
    expect(recon).not.toContain(ALSO);
  };

  it("a kept student create", async () => {
    const [zoe] = await db.insert(student).values({ name: "Zoe Rivera", familyId: rivera, active: true }).returning({ id: student.id });
    const create = await seedQueued({ op: "create", role: "student", name: "Zoe Rivera", typeQboId: "3", familyQboId: "10", email: null }, { state: "refused", code: "fault_6000", nextTryAt: null });
    await db.update(writeQueue).set({ studentId: zoe!.id }).where(eq(writeQueue.id, create.id));
    await notMoved();
  });

  it("a guardian's kept rename and make-inactive", async () => {
    await seedQueued({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "Ana R. Rivera", was: "Ana Rivera", guardianId: anaRow.id }, { state: "refused", code: "fault_6000", nextTryAt: null });
    await seedQueued({ op: "deactivate", role: "parent", qboId: "11", syncToken: "0", guardianId: anaRow.id }, { state: "refused", code: "fault_6000", nextTryAt: null });
    await notMoved();
  });

  it("a kept phone change and sign-in email change, with their compare views audited as before", async () => {
    const contact = await seedQueued({ op: "contact", role: "parent", qboId: "11", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0100" }, guardianId: anaRow.id },
      { state: "refused", code: CONTACT_DIFFERS, nextTryAt: null });
    const email = await seedQueued({ op: "email", role: "parent", qboId: "11", syncToken: "0", from: "ana@example.com", to: "ana.new@example.com", guardianId: anaRow.id },
      { state: "refused", code: EMAIL_DIFFERS, nextTryAt: null });
    await notMoved();
    const seer = await staffWith("seer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]);
    expect(await writes(seer, { compare: contact.id })).toContain("QuickBooks has: ");
    expect(await auditsOf("parent.details.compared")).toEqual([expect.objectContaining({ actorId: seer.id, after: { queueId: contact.id } })]);
    expect(await writes(seer, { compare: email.id })).toContain("QuickBooks has: ");
    expect(await auditsOf("parent.email.compared")).toEqual([expect.objectContaining({ actorId: seer.id, after: expect.objectContaining({ queueId: email.id }) })]);
    // The list itself, and the screen, write no audit row.
    const before = (await auditsOf("parent.details.compared")).length + (await auditsOf("parent.email.compared")).length;
    await writes(seer);
    await linksList();
    expect((await auditsOf("parent.details.compared")).length + (await auditsOf("parent.email.compared")).length).toBe(before);
  });

  it("a make-inactive held for a balance owed, a credit, one unread and QuickBooks' fault_6220", async () => {
    await db.update(student).set({ active: false }).where(eq(student.id, leo));
    for (const code of ["open_balance", "credit_balance", "balance_unread:no_balance", "fault_6220"]) {
      await db.delete(writeQueue);
      await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { state: "refused", code, nextTryAt: null });
      await notMoved();
    }
  });

  it("a rename refused as taken", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    await readAgain();
    await keptRenameOfRivera("family", "fault_6240");
    await notMoved();
  });

  it("a kept rename of a record whose link was ended", async () => {
    await unlinkThroughThePress(rivera, full);
    // Filed under the family record as the writer filed it before the unlink: seedQueued() would otherwise import a
    // second family for the customer no family is linked to now.
    await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Rivera Family", was: "Rivera Old" }, { state: "refused", code: "fault_6000", nextTryAt: null, familyId: rivera });
    await notMoved();
  });

  it("any kept item while the screen's state isn't `listed`", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    await readAgain();
    await keptRenameOfRivera();
    expect(await everyKept()).toHaveLength(1);
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    expect((await loadAccountingLinks()).state).toBe("no_shape");
    await notMoved();
  });
});
