import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { role } from "@/lib/db/schema";
import { resetDb, seedStaff } from "../helpers/db";

describe("schema", () => {
  beforeEach(resetDb);

  it("ships exactly one built-in Admin role", async () => {
    const roles = await db.select().from(role);
    expect(roles.filter((r) => r.builtin)).toEqual([expect.objectContaining({ key: "admin", name: "Admin" })]);
  });

  it("rejects two staff users with the same email", async () => {
    await seedStaff({ email: "pat@club.org" });
    await expect(seedStaff({ email: " PAT@club.org " })).rejects.toThrow();
  });
});
