import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, roleAssignment, setting } from "@/lib/db/schema";
import { getSetupState, updateSetupState, SETUP_CODE_KEY } from "@/lib/setup/state";
import { issueSetupCode } from "@/lib/setup/code";
import { resetDb, seedStaff } from "../helpers/db";

const mocks = vi.hoisted(() => ({ hasSetupSession: vi.fn(), getStaffIdentity: vi.fn(), hasStaffSession: vi.fn() }));
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: mocks.hasSetupSession, SETUP_COOKIE: "br_setup" }));
vi.mock("@/lib/auth/identity", () => ({ getStaffIdentity: mocks.getStaffIdentity, hasStaffSession: mocks.hasStaffSession }));

import { GET } from "@/app/setup/finish/route";

const call = () => GET(new Request("http://localhost:3100/setup/finish"));
const location = (r: Response) => { const u = new URL(r.headers.get("location")!); return u.pathname + u.search; };
const signedInAs = (s: { id: string; email: string; name: string }) => {
  mocks.hasStaffSession.mockResolvedValue(true);
  mocks.getStaffIdentity.mockResolvedValue({ door: "staff", staffUserId: s.id, name: s.name, email: s.email });
};
const actions = async () => (await db.select().from(auditLog)).map((a) => a.action);
const codeRows = async () => db.select().from(setting).where(eq(setting.key, SETUP_CODE_KEY));

describe("setup finish route", () => {
  beforeEach(async () => {
    await resetDb();
    vi.resetAllMocks();
    mocks.hasSetupSession.mockResolvedValue(true);
    mocks.hasStaffSession.mockResolvedValue(false);
    mocks.getStaffIdentity.mockResolvedValue(null);
    await issueSetupCode();
    await updateSetupState({ status: "open", step: "admin", adminEmail: "admin@club.org" });
    await db.delete(auditLog); // issuing the code audited itself; each test looks only at what the route writes
  });

  it("finishes when the right Admin is signed in, voids the code, audits, and clears the setup cookie", async () => {
    const admin = await seedStaff({ email: "admin@club.org", admin: true });
    signedInAs(admin);
    const res = await call();
    expect(location(res)).toBe("/staff");
    expect((await getSetupState()).status).toBe("finished");
    expect(await codeRows()).toHaveLength(0);
    expect(await actions()).toEqual(["setup.finish"]);
    expect(res.headers.get("set-cookie")).toMatch(/br_setup=;/);
  });

  it("sends a browser with no setup session to /setup", async () => {
    mocks.hasSetupSession.mockResolvedValue(false);
    expect(location(await call())).toBe("/setup");
    expect((await getSetupState()).status).toBe("open");
  });

  it("refuses another email, stays open, and audits the refusal", async () => {
    await seedStaff({ email: "admin@club.org", admin: true });
    const other = await seedStaff({ email: "other@club.org", admin: true });
    signedInAs(other);
    expect(location(await call())).toBe("/setup?step=admin&error=other_email");
    expect((await getSetupState()).status).toBe("open");
    expect(await codeRows()).toHaveLength(1);
    const [row] = await db.select().from(auditLog);
    expect(await actions()).toEqual(["setup.finish.refused"]);
    expect(row).toMatchObject({ door: "staff", actorId: other.id, actorLabel: "other@club.org", after: { reason: "other_email" } });
  });

  it("refuses a staff member who is not an Admin, stays open, and audits the refusal", async () => {
    const member = await seedStaff({ email: "admin@club.org" });
    signedInAs(member);
    expect(location(await call())).toBe("/setup?step=admin&error=not_admin");
    expect((await getSetupState()).status).toBe("open");
    const [row] = await db.select().from(auditLog);
    expect(await actions()).toEqual(["setup.finish.refused"]);
    expect(row).toMatchObject({ door: "staff", actorId: member.id, after: { reason: "not_admin" } });
  });

  it("finishes a reopened setup for an existing Admin without adding a second role assignment", async () => {
    const admin = await seedStaff({ email: "admin@club.org", admin: true });
    signedInAs(admin);
    expect(location(await call())).toBe("/staff");
    expect((await getSetupState()).status).toBe("finished");
    expect(await db.select().from(roleAssignment)).toHaveLength(1);
  });

  it("goes to /staff when setup is already finished", async () => {
    await updateSetupState({ status: "finished" });
    expect(location(await call())).toBe("/staff");
    expect(await actions()).toEqual([]);
  });
});
