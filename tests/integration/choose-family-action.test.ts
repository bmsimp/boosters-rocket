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

  it("refuses anything but a short string, leaves the session's family alone and doesn't audit the value", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: a.id, familyQboId: "F1" }); await seedGuardian({ parentId: a.id, familyQboId: "F2" });
    await post("/portal-code/send", { email: "ana@example.com" });
    await vi.waitFor(() => expect(state.outbox).toHaveLength(1));
    const code = /sign-in code: (\d{6})/.exec(state.outbox[0]!.subject)![1]!;
    const res = await post("/portal-code/verify", { email: "ana@example.com", code });
    state.cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => c.startsWith("br_parent")).join("; ");
    expect(await redirectOf(chooseFamilyAction("F1"))).toBe("/");

    const marker = "x".repeat(10_000);
    const bad: unknown[] = [{ familyQboId: "F2", marker: "obj-marker" }, ["F2", "arr-marker"], 4242424242, marker, "", "F".repeat(65)];
    for (const v of bad) {
      expect(await redirectOf((chooseFamilyAction as (x: unknown) => Promise<void>)(v))).toBe("/choose-family");
      expect((await db.select().from(parentAuthSession))[0]!.familyQboId).toBe("F1");
    }
    const refused = (await db.select().from(auditLog)).filter((x) => x.action === "signin.refused");
    expect(refused).toHaveLength(bad.length);
    for (const r of refused) expect(r).toMatchObject({ actorId: a.id, targetId: a.id, after: { reason: "family_not_enabled" } });
    const all = JSON.stringify(await db.select().from(auditLog));
    for (const needle of ["obj-marker", "arr-marker", "4242424242", "xxxxxxxxxx", "F".repeat(65)]) expect(all).not.toContain(needle);
  });
});
