import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const state = vi.hoisted(() => ({ outbox: [] as Msg[], cookie: "" }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { state.outbox.push(m); } }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: state.cookie, "cf-connecting-ip": "203.0.113.31" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); } }));

import { db } from "@/lib/db/client";
import { auditLog, parentAuthSession } from "@/lib/db/schema";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { chooseFamilyAction } from "@/app/choose-family/actions";
import ChooseFamily from "@/app/choose-family/page";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { guardian } from "@/lib/db/schema";
import { recordNameWords } from "@/lib/families/words";
import { env } from "@/env";
import { resetDb, seedParent, seedGuardian, seedWorkingMail } from "../helpers/db";

async function post(path: string, body: unknown) {
  return (await getParentAuth()).handler(new Request(`${env.APP_URL}/api/auth/parent${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: env.APP_URL, "cf-connecting-ip": "203.0.113.31" },
  }));
}
const redirectOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { url?: string }).url ?? String(e); } };

describe("chooseFamilyAction", () => {
  beforeEach(async () => { await resetDb(); state.outbox.length = 0; state.cookie = ""; await seedWorkingMail(); });

  it("the chooser says 'more than one family' only when there is more than one to choose from", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: a.id, familyQboId: "F1" }); const second = await seedGuardian({ parentId: a.id, familyQboId: "F2" });
    await post("/portal-code/send", { email: "ana@example.com" });
    await vi.waitFor(() => expect(state.outbox).toHaveLength(1));
    const res = await post("/portal-code/verify", { email: "ana@example.com", code: /sign-in code: (\d{6})/.exec(state.outbox[0]!.subject)![1]! });
    state.cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => c.startsWith("br_parent")).join("; ");
    const two = renderToStaticMarkup(await ChooseFamily());
    expect(two).toContain("more than one family");
    expect(two.match(/<button class="btn"/g)).toHaveLength(2);
    // No family's QuickBooks id is on the page: each is named in words here (neither has a family record) and chosen by its row.
    expect(two).not.toMatch(/F1|F2|Family account/);
    // Neither name is known, so the two buttons are told apart by their place in the list (React writes ' as &#x27;).
    const unknown = recordNameWords(null, "family").replaceAll("'", "&#x27;");
    expect(two).toContain(`>${unknown} (1)</button>`);
    expect(two).toContain(`>${unknown} (2)</button>`);
    // The chosen family goes away and one is left: the parent is sent back here, with one family to choose.
    expect(await redirectOf(chooseFamilyAction(second.id))).toBe("/");
    expect((await db.select().from(parentAuthSession))[0]!.familyQboId).toBe("F2");
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" }).where(eq(guardian.id, second.id));
    const one = renderToStaticMarkup(await ChooseFamily());
    expect(one.match(/<button class="btn"/g)).toHaveLength(1);
    expect(one).not.toContain("more than one family");
    expect(one).toContain("Choose the family to look at.");
  });

  it("refuses anything but a uuid, leaves the session's family alone and records only a short string sent", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const first = await seedGuardian({ parentId: a.id, familyQboId: "F1" }); const second = await seedGuardian({ parentId: a.id, familyQboId: "F2" });
    await post("/portal-code/send", { email: "ana@example.com" });
    await vi.waitFor(() => expect(state.outbox).toHaveLength(1));
    const code = /sign-in code: (\d{6})/.exec(state.outbox[0]!.subject)![1]!;
    const res = await post("/portal-code/verify", { email: "ana@example.com", code });
    state.cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => c.startsWith("br_parent")).join("; ");
    expect(await redirectOf(chooseFamilyAction(first.id))).toBe("/");

    const marker = "x".repeat(10_000);
    // A family's QuickBooks id is not a row's id, and neither is a row's id in capitals or with anything around it.
    const bad: unknown[] = [{ guardianId: second.id, marker: "obj-marker" }, [second.id, "arr-marker"], 4242424242, marker, "", "F".repeat(65), "F2",
      second.id.toUpperCase(), ` ${second.id}`];
    for (const v of bad) {
      expect(await redirectOf((chooseFamilyAction as (x: unknown) => Promise<void>)(v))).toBe("/choose-family");
      expect((await db.select().from(parentAuthSession))[0]!.familyQboId).toBe("F1");
    }
    const refused = (await db.select().from(auditLog)).filter((x) => x.action === "signin.refused");
    expect(refused).toHaveLength(bad.length);
    for (const r of refused) expect(r).toMatchObject({ actorId: a.id, targetId: a.id, after: { reason: "family_not_enabled" } });
    // A string of 1 to 64 characters is what the browser sent, and the refusal records it, as it did a family id before.
    const sent = refused.map((r) => (r.after as { sent?: string }).sent).filter((s) => s !== undefined).sort();
    expect(sent).toEqual(["F2", second.id.toUpperCase(), ` ${second.id}`].sort());
    const all = JSON.stringify(await db.select().from(auditLog));
    for (const needle of ["obj-marker", "arr-marker", "4242424242", "xxxxxxxxxx", "F".repeat(65)]) expect(all).not.toContain(needle);
  });

  it("refuses the person's own row once it is closed, and one a change of company closed, naming the row and leaving the session's family", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const first = await seedGuardian({ parentId: a.id, familyQboId: "F1" }); const second = await seedGuardian({ parentId: a.id, familyQboId: "F2" });
    // A row a change of company closed: another company's family, and no family record of the portal's (family_id null).
    const earlier = await seedGuardian({ parentId: a.id, familyQboId: "OLD-F", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    expect(earlier.familyId).toBeNull();
    await post("/portal-code/send", { email: "ana@example.com" });
    await vi.waitFor(() => expect(state.outbox).toHaveLength(1));
    const res = await post("/portal-code/verify", { email: "ana@example.com", code: /sign-in code: (\d{6})/.exec(state.outbox[0]!.subject)![1]! });
    state.cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => c.startsWith("br_parent")).join("; ");
    expect(await redirectOf(chooseFamilyAction(first.id))).toBe("/");
    // The second row closes while the session is open: the chooser's button for it, posted now, is refused.
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" }).where(eq(guardian.id, second.id));
    const before = (await db.select().from(auditLog)).filter((x) => x.action === "signin.refused").length;
    for (const row of [second, earlier]) {
      expect(await redirectOf(chooseFamilyAction(row.id))).toBe("/choose-family");
      expect((await db.select().from(parentAuthSession))[0]!.familyQboId).toBe("F1");
    }
    const refused = (await db.select().from(auditLog)).filter((x) => x.action === "signin.refused");
    expect(refused).toHaveLength(before + 2);
    for (const row of [second, earlier]) {
      expect(refused.filter((r) => (r.after as { guardianId?: string }).guardianId === row.id)).toEqual([
        expect.objectContaining({ actorId: a.id, targetId: a.id, after: { reason: "family_not_enabled", guardianId: row.id } })]);
    }
    expect((await db.select().from(auditLog)).filter((x) => x.action === "signin.family_switch")).toEqual([]);
  });
});
