import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { authProvider, auditLog } from "@/lib/db/schema";
import { createSecretBox } from "@/lib/crypto/secret-box";
import { loadProviders, providerSummaries, saveProvider, removeProvider, parseProviderForm, providersVersion, type CheckFn } from "@/lib/auth/providers";
import { resetDb, seedProvider } from "../helpers/db";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";
const actor = { door: "system" as const, id: null, label: "setup" };
const pass: CheckFn = async () => ({ ok: true });
const draft = (secret: string | null = "the-secret") => {
  const r = parseProviderForm("staff-microsoft", { tenantId: T, clientId: C, secret: secret ?? "" });
  if (!r.ok) throw new Error(r.errors.join());
  return r.draft;
};

describe("stored providers", () => {
  beforeEach(resetDb);

  it("saves encrypted, loads decrypted, and audits without the secret", async () => {
    expect(await saveProvider(draft(), { actor, ip: null, updatedBy: null, check: pass })).toEqual({ ok: true });
    const [row] = await db.select().from(authProvider);
    expect(row!.secretCiphertext).not.toContain("the-secret");
    expect((await loadProviders()).staffMicrosoft).toMatchObject({ config: { tenantId: T, clientId: C }, secret: "the-secret" });
    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "setup.provider.save", targetId: "staff-microsoft" });
    expect(JSON.stringify(audit[0])).not.toContain("the-secret");
    expect(audit[0]!.after).toMatchObject({ secretChanged: true });
  });

  it("bumps the version so sign-in rebuilds", async () => {
    const before = providersVersion();
    await saveProvider(draft(), { actor, ip: null, updatedBy: null, check: pass });
    expect(providersVersion()).toBeGreaterThan(before);
  });

  it("saves nothing when the check fails", async () => {
    const r = await saveProvider(draft(), { actor, ip: null, updatedBy: null, check: async () => ({ ok: false, message: "nope" }) });
    expect(r).toEqual({ ok: false, errors: ["nope"] });
    expect(await db.select().from(authProvider)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("keeps the saved secret when the form leaves it blank, and checks with it", async () => {
    await saveProvider(draft("first"), { actor, ip: null, updatedBy: null, check: pass });
    let checkedWith = "";
    await saveProvider(draft(null), { actor, ip: null, updatedBy: null, check: async (d) => { checkedWith = d.secret; return { ok: true }; } });
    expect(checkedWith).toBe("first");
    expect((await loadProviders()).staffMicrosoft?.secret).toBe("first");
    expect((await db.select().from(auditLog))[1]!.after).toMatchObject({ secretChanged: false });
  });

  it("asks for the secret when there is none saved yet", async () => {
    expect(await saveProvider(draft(null), { actor, ip: null, updatedBy: null, check: pass })).toEqual({ ok: false, errors: ["Enter the client secret."] });
  });

  it("skips a provider whose secret can't be decrypted", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
    await db.update(authProvider).set({ secretKeyId: "deadbeef" }).where(eq(authProvider.key, "staff-microsoft"));
    const other = createSecretBox({ current: Buffer.from("previous-key-previous-key-prev!!").toString("base64") });
    const loaded = await loadProviders();
    expect(loaded.staffMicrosoft).toBeNull();
    expect(loaded.staffGoogle).not.toBeNull();
    expect((await providerSummaries(other)).every((s) => !s.readable)).toBe(true);
  });

  it("summaries never contain the secret", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C }, "never-show-me");
    expect(JSON.stringify(await providerSummaries())).not.toContain("never-show-me");
  });

  it("refuses to remove the last staff provider, allows it when another exists, and audits", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    expect(await removeProvider("staff-microsoft", { actor, ip: null })).toEqual({ ok: false, errors: ["This would leave no way for staff to sign in."] });
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
    expect(await removeProvider("staff-microsoft", { actor, ip: null })).toEqual({ ok: true });
    expect((await loadProviders()).staffMicrosoft).toBeNull();
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["setup.provider.remove.refused", "setup.provider.remove"]);
  });

  it("does not count an unreadable staff row as another way to sign in, and audits the refusal", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
    await db.update(authProvider).set({ secretKeyId: "deadbeef" }).where(eq(authProvider.key, "staff-google"));
    const perm = "Settings.SignIn.ReadWrite";
    expect(await removeProvider("staff-microsoft", { actor, ip: null, permission: perm })).toEqual({ ok: false, errors: ["This would leave no way for staff to sign in."] });
    expect(await db.select().from(authProvider)).toHaveLength(2);
    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "setup.provider.remove.refused", permission: perm, targetId: "staff-microsoft", door: "system", after: { reason: "last_staff_sign_in" } });
  });

  it("removes the parent provider freely", async () => {
    await seedProvider("parent-oidc", { tenantSubdomain: "p", tenantId: T, clientId: C });
    expect(await removeProvider("parent-oidc", { actor, ip: null })).toEqual({ ok: true });
  });
});
