import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { authProvider, auditLog, providerCertificate } from "@/lib/db/schema";
import { createSecretBox } from "@/lib/crypto/secret-box";
import {
  loadProviders, providerSummaries, saveProvider, removeProvider, parseProviderForm, providersVersion, invalidateProviders, type CheckFn,
} from "@/lib/auth/providers";
import { certificateRows, getOrCreatePendingCertificate } from "@/lib/auth/certificates";
import { resetDb, seedProvider } from "../helpers/db";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";
const G = "x.apps.googleusercontent.com";
const actor = { door: "system" as const, id: null, label: "setup" };
const pass: CheckFn = async () => ({ ok: true });
const googleDraft = (secret: string | null = "the-secret") => {
  const r = parseProviderForm("staff-google", { clientId: G, secret: secret ?? "" });
  if (!r.ok) throw new Error(r.errors.join());
  return r.draft;
};
const msDraft = () => {
  const r = parseProviderForm("staff-microsoft", { tenantId: T, clientId: C });
  if (!r.ok) throw new Error(r.errors.join());
  return r.draft;
};

describe("stored providers: Google (client secret)", () => {
  beforeEach(resetDb);

  it("saves encrypted, loads decrypted, and audits without the secret", async () => {
    expect(await saveProvider(googleDraft(), { actor, ip: null, updatedBy: null, check: pass })).toEqual({ ok: true });
    const [row] = await db.select().from(authProvider);
    expect(row!.secretCiphertext).not.toContain("the-secret");
    expect((await loadProviders()).staffGoogle).toMatchObject({ config: { clientId: G }, secret: "the-secret" });
    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "setup.provider.save", targetId: "staff-google" });
    expect(JSON.stringify(audit[0])).not.toContain("the-secret");
    expect(audit[0]!.after).toMatchObject({ secretChanged: true });
  });

  it("bumps the version so sign-in rebuilds", async () => {
    const before = providersVersion();
    await saveProvider(googleDraft(), { actor, ip: null, updatedBy: null, check: pass });
    expect(providersVersion()).toBeGreaterThan(before);
  });

  it("saves nothing when the check fails", async () => {
    const r = await saveProvider(googleDraft(), { actor, ip: null, updatedBy: null, check: async () => ({ ok: false, message: "nope" }) });
    expect(r).toEqual({ ok: false, errors: ["nope"] });
    expect(await db.select().from(authProvider)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("keeps the saved secret when the form leaves it blank, and checks with it", async () => {
    await saveProvider(googleDraft("first"), { actor, ip: null, updatedBy: null, check: pass });
    let checkedWith = "";
    await saveProvider(googleDraft(null), { actor, ip: null, updatedBy: null, check: async (d) => { if ("secret" in d) checkedWith = d.secret; return { ok: true }; } });
    expect(checkedWith).toBe("first");
    expect((await loadProviders()).staffGoogle?.secret).toBe("first");
    expect((await db.select().from(auditLog))[1]!.after).toMatchObject({ secretChanged: false });
  });

  it("asks for the secret when there is none saved yet", async () => {
    expect(await saveProvider(googleDraft(null), { actor, ip: null, updatedBy: null, check: pass })).toEqual({ ok: false, errors: ["Enter the client secret."] });
  });

  it("skips a provider whose secret can't be decrypted", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    await seedProvider("staff-google", { clientId: G });
    await db.update(authProvider).set({ secretKeyId: "deadbeef" }).where(eq(authProvider.key, "staff-google"));
    invalidateProviders();
    const other = createSecretBox({ current: Buffer.from("previous-key-previous-key-prev!!").toString("base64") });
    const loaded = await loadProviders();
    expect(loaded.staffGoogle).toBeNull();
    expect(loaded.staffMicrosoft).not.toBeNull();
    expect((await providerSummaries(other)).every((s) => !s.readable)).toBe(true);
  });

  it("summaries never contain the secret", async () => {
    await seedProvider("staff-google", { clientId: G }, "never-show-me");
    const s = await providerSummaries();
    expect(JSON.stringify(s)).not.toContain("never-show-me");
    expect(s[0]).toMatchObject({ key: "staff-google", readable: true, certificate: null, pendingCertificate: null });
  });
});

describe("stored providers: Microsoft (certificate)", () => {
  beforeEach(resetDb);

  it("saves Microsoft with the pending certificate, activates it, and audits", async () => {
    const pending = await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
    let used = "";
    const check: CheckFn = async (d) => { if ("assertion" in d) used = d.assertion.thumbprintS256; return { ok: true }; };
    expect(await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check })).toEqual({ ok: true });
    expect(used).toBe(pending.thumbprintS256);
    expect((await certificateRows("staff-microsoft")).active!.id).toBe(pending.id);
    const loaded = (await loadProviders()).staffMicrosoft!;
    expect(loaded.assertion.thumbprintS256).toBe(pending.thumbprintS256);
    expect(loaded.expiresAt.toISOString()).toBe(pending.notAfter.toISOString());
    const [row] = await db.select().from(authProvider);
    expect(row!.secretCiphertext).toBeNull();
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["certificate.create", "certificate.activate", "setup.provider.save"]);
  });

  it("audits the certificate on save, without key material", async () => {
    const pending = await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
    await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check: pass });
    const save = (await db.select().from(auditLog)).find((a) => a.action === "setup.provider.save")!;
    expect(save.after).toMatchObject({ tenantId: T, clientId: C, certificateThumbprintSha1: pending.thumbprintSha1, certificateChanged: true });
    expect(JSON.stringify(save)).not.toContain("PRIVATE KEY");
  });

  it("keeps the certificate pending when Microsoft rejects it", async () => {
    await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
    const r = await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check: async () => ({ ok: false, message: "nope" }) });
    expect(r).toEqual({ ok: false, errors: ["nope"] });
    expect((await certificateRows("staff-microsoft")).pending).not.toBeNull();
    expect(await db.select().from(authProvider)).toHaveLength(0);
  });

  it("refuses the save if the certificate changed while it was being checked", async () => {
    const pending = await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
    const r = await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check: async () => {
      await db.update(providerCertificate).set({ status: "retired", privateKeyCiphertext: null, privateKeyKeyId: null }).where(eq(providerCertificate.id, pending.id));
      return { ok: true };
    } });
    expect(r).toEqual({ ok: false, errors: ["The certificate changed while this was being checked. Try again."] });
    expect(await db.select().from(authProvider)).toHaveLength(0);
  });

  it("asks for the certificate before a first Microsoft save", async () => {
    const r = await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check: async () => ({ ok: true }) });
    expect(r).toEqual({ ok: false, errors: ["Download the certificate and add it to the app registration first."] });
  });

  it("refuses to save with a certificate whose key can't be decrypted", async () => {
    await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
    await db.update(providerCertificate).set({ privateKeyKeyId: "deadbeef" });
    const r = await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check: pass });
    expect(r).toEqual({ ok: false, errors: ["This server can't read the certificate's key any more. Create a new certificate and upload it."] });
  });

  it("a pending replacement doesn't change what sign-in uses", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    const before = (await loadProviders()).staffMicrosoft!.assertion.thumbprintS256;
    await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
    invalidateProviders();
    expect((await loadProviders()).staffMicrosoft!.assertion.thumbprintS256).toBe(before);
  });

  it("re-saving only the IDs checks with the active certificate", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    const active = (await certificateRows("staff-microsoft")).active!;
    let used = "";
    await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check: async (d) => { if ("assertion" in d) used = d.assertion.thumbprintS256; return { ok: true }; } });
    expect(used).toBe(active.thumbprintS256);
  });

  it("saving with a pending replacement activates it and retires the old one", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    const old = (await certificateRows("staff-microsoft")).active!;
    const pending = await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
    expect(await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check: pass })).toEqual({ ok: true });
    expect((await certificateRows("staff-microsoft")).active!.id).toBe(pending.id);
    const [retired] = await db.select().from(providerCertificate).where(eq(providerCertificate.id, old.id));
    expect(retired).toMatchObject({ status: "retired", privateKeyCiphertext: null });
    expect((await loadProviders()).staffMicrosoft!.assertion.thumbprintS256).toBe(pending.thumbprintS256);
  });

  it("skips a Microsoft provider whose key can't be decrypted", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    await db.update(providerCertificate).set({ privateKeyKeyId: "deadbeef" });
    invalidateProviders();
    expect((await loadProviders()).staffMicrosoft).toBeNull();
    expect((await providerSummaries()).find((s) => s.key === "staff-microsoft")!.readable).toBe(false);
  });

  it("removing a Microsoft provider retires its certificates", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    await seedProvider("staff-google", { clientId: G });
    expect(await removeProvider("staff-microsoft", { actor, ip: null })).toEqual({ ok: true });
    expect((await db.select().from(providerCertificate)).every((r) => r.status === "retired" && r.privateKeyCiphertext === null)).toBe(true);
  });

  it("summaries show certificate thumbprints and never key material", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    const pending = await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
    const s = (await providerSummaries()).find((x) => x.key === "staff-microsoft")!;
    expect(s.certificate).not.toBeNull();
    expect(s.pendingCertificate!.thumbprintSha1).toBe(pending.thumbprintSha1);
    expect(s.expiresAt!.toISOString()).toBe(s.certificate!.notAfter.toISOString());
    expect(JSON.stringify(s)).not.toContain("PRIVATE KEY");
    expect(s).not.toHaveProperty("certificate.privateKeyCiphertext");
  });

  it("loads the parent provider with its certificate", async () => {
    await seedProvider("parent-oidc", { tenantSubdomain: "p", tenantId: T, clientId: C });
    const p = (await loadProviders()).parent!;
    expect(p.config).toEqual({ tenantSubdomain: "p", tenantId: T, clientId: C });
    expect(p.assertion.privateKeyPem).toContain("PRIVATE KEY");
  });
});

describe("removing providers", () => {
  beforeEach(resetDb);

  it("refuses to remove the last staff provider, allows it when another exists, and audits", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    expect(await removeProvider("staff-microsoft", { actor, ip: null })).toEqual({ ok: false, errors: ["This would leave no way for staff to sign in."] });
    await seedProvider("staff-google", { clientId: G });
    expect(await removeProvider("staff-microsoft", { actor, ip: null })).toEqual({ ok: true });
    expect((await loadProviders()).staffMicrosoft).toBeNull();
    expect((await db.select().from(auditLog)).map((a) => a.action))
      .toEqual(["setup.provider.remove.refused", "certificate.retire", "setup.provider.remove"]);
  });

  it("counts a Microsoft sign-in with a readable certificate as another way in", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    await seedProvider("staff-google", { clientId: G });
    expect(await removeProvider("staff-google", { actor, ip: null })).toEqual({ ok: true });
  });

  it("does not count a Microsoft sign-in whose certificate can't be decrypted", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    await seedProvider("staff-google", { clientId: G });
    await db.update(providerCertificate).set({ privateKeyKeyId: "deadbeef" });
    expect(await removeProvider("staff-google", { actor, ip: null })).toEqual({ ok: false, errors: ["This would leave no way for staff to sign in."] });
  });

  it("does not count an unreadable staff row as another way to sign in, and audits the refusal", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    await seedProvider("staff-google", { clientId: G });
    await db.update(authProvider).set({ secretKeyId: "deadbeef" }).where(eq(authProvider.key, "staff-google"));
    const perm = "Settings.SignIn.ReadWrite";
    expect(await removeProvider("staff-microsoft", { actor, ip: null, permission: perm })).toEqual({ ok: false, errors: ["This would leave no way for staff to sign in."] });
    expect(await db.select().from(authProvider)).toHaveLength(2);
    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "setup.provider.remove.refused", permission: perm, targetId: "staff-microsoft", door: "system", after: { reason: "last_staff_sign_in" } });
  });

  it("removes the parent provider freely, retiring its certificate", async () => {
    await seedProvider("parent-oidc", { tenantSubdomain: "p", tenantId: T, clientId: C });
    expect(await removeProvider("parent-oidc", { actor, ip: null })).toEqual({ ok: true });
    expect((await certificateRows("parent-oidc")).active).toBeNull();
  });
});
