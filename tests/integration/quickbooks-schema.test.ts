import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { qboConnection, qboCustomer, qboCustomerType, jobRun } from "@/lib/db/schema";
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
