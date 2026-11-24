import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { qboConnection, qboCustomer, qboCustomerType, qboRelay, jobRun } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

describe("QuickBooks tables", () => {
  beforeEach(resetDb);

  it("holds at most one connection row", async () => {
    const row = { environment: "sandbox" as const, clientId: "id", clientSecretCiphertext: "c", clientSecretKeyId: "k" };
    await db.insert(qboConnection).values(row);
    await expect(db.insert(qboConnection).values(row)).rejects.toThrow();
    expect(await db.select().from(qboConnection)).toHaveLength(1);
  });

  it("rejects a connection row with any id but the singleton, with or without an existing row", async () => {
    const row = { environment: "sandbox" as const, clientId: "id", clientSecretCiphertext: "c", clientSecretKeyId: "k" };
    await expect(db.insert(qboConnection).values({ ...row, id: "other" })).rejects.toThrow();
    await db.insert(qboConnection).values(row);
    await expect(db.insert(qboConnection).values({ ...row, id: "other" })).rejects.toThrow();
    expect(await db.select().from(qboConnection)).toHaveLength(1);
  });

  it("keeps customers and types by their QuickBooks ID, and a job run with its outcome", async () => {
    await db.insert(qboCustomerType).values({ qboId: "5", name: "Family", active: true });
    await db.insert(qboCustomer).values({ qboId: "12", displayName: "Rivera Family", active: true, typeQboId: "5", syncToken: "0" });
    await db.insert(qboCustomer).values({ qboId: "13", displayName: "Ana Rivera", active: true, parentQboId: "12", syncToken: "0" });
    await expect(db.insert(qboCustomer).values({ qboId: "12", displayName: "Again", active: true, syncToken: "0" })).rejects.toThrow();
    const [run] = await db.insert(jobRun).values({ job: "roster.refresh", startedBy: "worker" }).returning();
    expect(run!.outcome).toBeNull();
    expect(run!.finishedAt).toBeNull();
  });

  it("is emptied by resetDb, all four tables", async () => {
    await db.insert(qboConnection).values({ environment: "sandbox", clientId: "id", clientSecretCiphertext: "c", clientSecretKeyId: "k" });
    await db.insert(qboCustomerType).values({ qboId: "5", name: "Family", active: true });
    await db.insert(qboCustomer).values({ qboId: "12", displayName: "Rivera Family", active: true, typeQboId: "5", syncToken: "0" });
    await db.insert(jobRun).values({ job: "roster.refresh", startedBy: "worker" });
    await resetDb();
    expect(await db.select().from(qboConnection)).toHaveLength(0);
    expect(await db.select().from(qboCustomerType)).toHaveLength(0);
    expect(await db.select().from(qboCustomer)).toHaveLength(0);
    expect(await db.select().from(jobRun)).toHaveLength(0);
    const [run] = await db.insert(jobRun).values({ job: "roster.refresh", startedBy: "worker" }).returning();
    expect(run!.id).toBe(1); // identities start again
  });
});

describe("the connection's modes and the relay's registration (0059)", () => {
  beforeEach(resetDb);
  const keys = { clientId: "id", clientSecretCiphertext: "c", clientSecretKeyId: "k" };

  it("makes a new connection row a relay one, with no tokens' mode and no pending state's", async () => {
    await db.insert(qboConnection).values({ environment: "sandbox" });
    const [c] = await db.select().from(qboConnection);
    expect([c!.connectMode, c!.tokenMode, c!.stateMode, c!.clientId]).toEqual(["relay", null, null, null]);
  });

  it("needs the club's own app's keys whenever either mode is own_app, and only then", async () => {
    await expect(db.insert(qboConnection).values({ environment: "sandbox", connectMode: "own_app" })).rejects.toThrow();
    await expect(db.insert(qboConnection).values({ environment: "sandbox", connectMode: "relay", tokenMode: "own_app" })).rejects.toThrow();
    await expect(db.insert(qboConnection).values({ environment: "sandbox", connectMode: "own_app", clientId: "id", clientSecretCiphertext: "c" })).rejects.toThrow();
    await db.insert(qboConnection).values({ environment: "sandbox", connectMode: "relay", tokenMode: "relay" });
    // Moving to the relay keeps the keys, so the club can move back.
    await db.update(qboConnection).set({ ...keys, connectMode: "own_app", tokenMode: "own_app" });
    await db.update(qboConnection).set({ connectMode: "relay", tokenMode: "relay" });
    await expect(db.update(qboConnection).set({ connectMode: "own_app", clientId: null })).rejects.toThrow();
    expect((await db.select().from(qboConnection))[0]!.clientId).toBe("id");
  });

  it("holds one registration at most, a public key as the relay registers it, and a portal id of the relay's form or none", async () => {
    const reg = { publicKey: "gbltJgDOnRxjmYnR45vZLQksg_FU67qiHffLEm4zqcY", privateKeyCiphertext: "c", privateKeyKeyId: "k", keyMadeAt: new Date() };
    await expect(db.insert(qboRelay).values({ ...reg, id: "other" })).rejects.toThrow();
    for (const publicKey of ["short", `${reg.publicKey}A`, reg.publicKey.replace("g", "+")]) await expect(db.insert(qboRelay).values({ ...reg, publicKey }), publicKey).rejects.toThrow();
    for (const portalId of ["brp_0123456789ABCDEF", "brp_0123456789abcde", "xyz_0123456789abcdef", " brp_0123456789abcdef"]) await expect(db.insert(qboRelay).values({ ...reg, portalId }), portalId).rejects.toThrow();
    await db.insert(qboRelay).values(reg);
    await expect(db.insert(qboRelay).values(reg)).rejects.toThrow();
    await db.update(qboRelay).set({ portalId: "brp_0123456789abcdef" });
    expect((await db.select().from(qboRelay))[0]!.portalId).toBe("brp_0123456789abcdef");
  });
});
