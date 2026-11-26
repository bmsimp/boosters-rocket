import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage, revalidatedPaths } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { PRESS_MAX } from "@/lib/bulk";
import { REFUSED_NOT_AGAIN, TRY_AGAIN_NEEDS_LINKING } from "@/lib/roster/queue";
import { giveUpManyAction, tryAgainManyAction } from "@/app/staff/(app)/roster/write-actions";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import { resetDb } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { connectRoster, queueItem, seedQueued, staffWith } from "../helpers/roster-writes";

/**
 * Reconciliation's bulk presses on a selection (src/lib/bulk.ts): Try again for many and Give up on many, with one note.
 * Each takes change ids from the browser, checks them for type, count and format, then does each by the single press's
 * own function (tryAgainNow(), giveUp()), in its own transaction with its own audit row, and answers row by row.
 */
vi.setConfig({ testTimeout: 60_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const NOT_FROM_PAGE = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const GONE = "That is no longer waiting: it went through, or was given up. Reload the page.";
const rename = (name: string) => ({ op: "rename" as const, role: "student" as const, qboId: "12", syncToken: "0", name, was: "Leo Rivera" });
const FAMILY_CREATE = { op: "create" as const, role: "family" as const, name: "Patel Family", typeQboId: "1", familyQboId: null, email: null };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((a) => a.action === action);

let registrar: Awaited<ReturnType<typeof staffWith>>;
beforeEach(async () => {
  await resetDb(); stub.reset();
  await connectRoster(stub);
  registrar = await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
  asStaff(registrar);
});

describe("Try again for many", () => {
  it("asks each stuck or waiting change again by Try again now's own function, and skips the rest with its words", async () => {
    const stuck = await seedQueued(rename("Leon Rivera"), { state: "stuck", tries: 8 });
    const waiting = await seedQueued(rename("Leonard Rivera"), { state: "waiting", nextTryAt: new Date(Date.now() + 3_600_000) });
    const kept = await seedQueued(rename("Leo R."), { state: "refused" });
    const done = await seedQueued(rename("Lee Rivera"), { state: "done" });
    const create = await seedQueued(FAMILY_CREATE, { state: "stuck" }); // a family's create: only someone who may link families
    const other = await seedQueued(rename("Untouched Rivera"), { state: "stuck" }); // not ticked
    const r = await tryAgainManyAction([stuck.id, waiting.id, kept.id, done.id, create.id, randomUUID()]);
    expect(r).toMatchObject({ ok: true, message: "2 asked to be tried again, 4 skipped.", left: [], rows: [
      { id: stuck.id, outcome: "done" }, { id: waiting.id, outcome: "done" },
      { id: kept.id, outcome: "skipped", why: REFUSED_NOT_AGAIN }, { id: done.id, outcome: "skipped", why: GONE },
      { id: create.id, outcome: "skipped", why: TRY_AGAIN_NEEDS_LINKING }, { outcome: "skipped", why: GONE },
    ] });
    expect(revalidatedPaths()).toContain("/staff");
    expect(await queueItem(stuck.id)).toMatchObject({ state: "waiting", tries: 8 });
    expect((await queueItem(waiting.id))!.nextTryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await queueItem(kept.id)).toMatchObject({ state: "refused" });
    expect(await queueItem(create.id)).toMatchObject({ state: "stuck" });
    expect(await queueItem(other.id)).toMatchObject({ state: "stuck" });
    // One audit row per change asked again, as Try again now writes it.
    expect((await audits("roster.write.again")).map((a) => [a.targetId, a.permission])).toEqual([[stuck.id, "Roster.Family.ReadWrite"], [waiting.id, "Roster.Family.ReadWrite"]]);
  });

  it("refuses what a page doesn't send, whole; tries at most PRESS_MAX and hands the rest back", async () => {
    const stuck = await seedQueued(rename("Leon Rivera"), { state: "stuck" });
    for (const ids of [[], stuck.id, [stuck.id, "not-a-uuid"], [7], Array.from({ length: 2001 }, () => randomUUID())]) {
      expect(await tryAgainManyAction(ids as never), JSON.stringify(ids).slice(0, 40)).toEqual(NOT_FROM_PAGE);
    }
    expect(await queueItem(stuck.id)).toMatchObject({ state: "stuck" });
    const ids = [...Array.from({ length: PRESS_MAX }, () => randomUUID()), stuck.id];
    const r = await tryAgainManyAction(ids);
    if (!r.ok) throw new Error("refused");
    expect(r.rows).toHaveLength(PRESS_MAX);
    expect(r.left).toEqual([stuck.id]);
    expect(await queueItem(stuck.id)).toMatchObject({ state: "stuck" }); // past the cap, untried
  });

  it("is Try again now's permissions: Roster.Family.ReadWrite refused as the guard refuses, Roster.Read needed too", async () => {
    const stuck = await seedQueued(rename("Leon Rivera"), { state: "stuck" });
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    await expect(tryAgainManyAction([stuck.id])).rejects.toBeInstanceOf(AccessDenied);
    asStaff(await staffWith("writer@club.org", ["Roster.Family.ReadWrite"]));
    expect(await tryAgainManyAction([stuck.id])).toEqual(NOT_FROM_PAGE);
    expect(await queueItem(stuck.id)).toMatchObject({ state: "stuck" });
    // Someone who may link families tries a family's create again.
    asStaff(await staffWith("linker@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]));
    const create = await seedQueued(FAMILY_CREATE, { state: "stuck" });
    expect(await tryAgainManyAction([create.id])).toMatchObject({ ok: true, rows: [{ outcome: "done" }] });
  });
});

describe("Give up on many", () => {
  it("gives up each change ticked by Give up's own function, with one note, and skips one gone already", async () => {
    const stuck = await seedQueued(rename("Leon Rivera"), { state: "stuck" });
    const waiting = await seedQueued(rename("Leonard Rivera"), { state: "waiting" });
    const kept = await seedQueued(rename("Leo R."), { state: "refused" });
    const done = await seedQueued(rename("Lee Rivera"), { state: "done" });
    const other = await seedQueued(rename("Untouched Rivera"), { state: "stuck" });
    const r = await giveUpManyAction([stuck.id, waiting.id, kept.id, done.id], "  Made by hand in QuickBooks. ");
    expect(r).toMatchObject({ ok: true, message: "3 given up, 1 skipped.", left: [], rows: [
      { id: stuck.id, outcome: "done" }, { id: waiting.id, outcome: "done" }, { id: kept.id, outcome: "done" }, { id: done.id, outcome: "skipped", why: GONE },
    ] });
    for (const i of [stuck, waiting, kept]) expect(await queueItem(i.id)).toMatchObject({ state: "given_up", note: "Made by hand in QuickBooks." });
    expect(await queueItem(other.id)).toMatchObject({ state: "stuck" });
    const given = await audits("roster.write.given_up");
    expect(given.map((a) => a.targetId)).toEqual([stuck.id, waiting.id, kept.id]);
    expect(given.every((a) => (a.after as { note: string }).note === "Made by hand in QuickBooks." && a.permission === "Roster.Family.ReadWrite")).toBe(true);
  });

  it("needs one note, checked once; refuses what a page doesn't send; tries at most PRESS_MAX", async () => {
    const stuck = await seedQueued(rename("Leon Rivera"), { state: "stuck" });
    expect(await giveUpManyAction([stuck.id], "   ")).toEqual({ ok: false, errors: ["Say why, in a few words. The note is kept in the audit log."] });
    expect(await giveUpManyAction([stuck.id], "x".repeat(501))).toEqual({ ok: false, errors: ["The note is too long (500 characters at most)."] });
    expect(await giveUpManyAction([stuck.id], 7 as never)).toEqual(NOT_FROM_PAGE);
    expect(await giveUpManyAction(["nope"], "Why")).toEqual(NOT_FROM_PAGE);
    expect(await queueItem(stuck.id)).toMatchObject({ state: "stuck" });
    const r = await giveUpManyAction([...Array.from({ length: PRESS_MAX }, () => randomUUID()), stuck.id], "Why");
    if (!r.ok) throw new Error("refused");
    expect(r.rows).toHaveLength(PRESS_MAX);
    expect(r.left).toEqual([stuck.id]);
    expect(await audits("roster.write.given_up")).toEqual([]);
  });

  it("is Give up's permissions", async () => {
    const stuck = await seedQueued(rename("Leon Rivera"), { state: "stuck" });
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    await expect(giveUpManyAction([stuck.id], "Why")).rejects.toBeInstanceOf(AccessDenied);
    expect(await queueItem(stuck.id)).toMatchObject({ state: "stuck" });
  });
});

describe("the page", () => {
  it("draws a box on each change for someone who may change families, and none for a reader", async () => {
    await seedQueued(rename("Leon Rivera"), { state: "stuck" });
    await seedQueued(rename("Leo R."), { state: "refused" });
    const html = await renderPage(ReconciliationPage);
    expect(html).toContain("Try 0 changes again");
    expect(html).toContain("Give up on 0 changes");
    expect(html).toContain("Select Rename the student");
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    const read = await renderPage(ReconciliationPage);
    expect(read).not.toContain("Select Rename the student");
    expect(read).not.toContain("Give up on 0 changes");
  });
});
