import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { auditLog, providerCertificate } from "@/lib/db/schema";
import { certificateRows } from "@/lib/auth/certificates";
import { SETUP_SESSION_ENDED } from "@/lib/setup/guard";
import { resetDb, seedProvider } from "../helpers/db";

const state = { setup: false };
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: async () => state.setup, SETUP_COOKIE: "br_setup", startSetupSession: async () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { startCertificateReplacementSetupAction, discardCertificateReplacementSetupAction } from "@/app/setup/actions";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";

describe("Replace certificate in a reopened setup", () => {
  beforeEach(async () => { await resetDb(); state.setup = false; });

  it("lets the setup session start a replacement for an active certificate, and discard it", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    const active = (await certificateRows("staff-microsoft")).active!;
    state.setup = true;
    expect(await startCertificateReplacementSetupAction("staff-microsoft")).toEqual({ ok: true });
    const { pending, active: still } = await certificateRows("staff-microsoft");
    expect(pending).not.toBeNull();
    expect(pending!.thumbprintSha1).not.toBe(active.thumbprintSha1);
    expect(still!.id).toBe(active.id);
    expect((await db.select().from(auditLog))[0]).toMatchObject({ action: "certificate.create", door: "system", actorLabel: "setup" });

    expect(await discardCertificateReplacementSetupAction("staff-microsoft")).toEqual({ ok: true });
    expect((await certificateRows("staff-microsoft")).pending).toBeNull();
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["certificate.create", "certificate.discard"]);
  });

  it("does nothing without a setup session, and says the session ended", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    expect(await startCertificateReplacementSetupAction("staff-microsoft")).toEqual({ ok: false, errors: [SETUP_SESSION_ENDED] });
    expect(await discardCertificateReplacementSetupAction("staff-microsoft")).toEqual({ ok: false, errors: [SETUP_SESSION_ENDED] });
    expect(await db.select().from(providerCertificate)).toHaveLength(1);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("refuses a sign-in that has no certificate", async () => {
    state.setup = true;
    expect(await startCertificateReplacementSetupAction("staff-google")).toEqual({ ok: false, errors: ["Unknown sign-in."] });
    expect(await startCertificateReplacementSetupAction("nope")).toEqual({ ok: false, errors: ["Unknown sign-in."] });
    expect(await db.select().from(providerCertificate)).toHaveLength(0);
  });
});
