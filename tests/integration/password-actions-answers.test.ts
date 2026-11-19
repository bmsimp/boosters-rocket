import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// The breach service is a stub listening on port 0 that has seen no password: the endpoint module is the one place its address lives.
const where = vi.hoisted(() => ({ range: "" }));
vi.mock("@/lib/parents/breach-endpoints", () => ({ breachEndpoints: () => ({ range: where.range }) }));
// The finish refusing a set-up link's sign-in (as a block or a reset landing between the set and the finish does), and
// the request's work throwing, each replaced from outside src/ so the actions' own answers can be read.
const finish = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/auth/parent-link-signin", () => ({ signInFromLink: async () => { finish.calls++; return null; } }));
vi.mock("@/lib/parents/password-request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/parents/password-request")>()),
  askForPasswordLink: async () => { throw new Error("the work failed"); },
}));
import { fromIp } from "../helpers/signed-in";

import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { askPasswordLinkAction, choosePasswordAction } from "@/app/sign-in/password-actions";
import { resetDb, seedGuardianInFamily, seedParent } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { credentialRows, mintLink } from "../helpers/signin-links";

/**
 * What the two actions before sign-in answer when the work behind them refuses or fails (the sign-in release, slice
 * SI-3a): a set-up link whose sign-in the finish refused answers that the password is set, with nowhere to go, so the
 * form never sends a parent with no session on; and the request page answers its one sentence when its work throws.
 */
const IP = "203.0.113.72";
const GOOD = "correct horse battery staple, the club's own";

let server: Server;
beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }).end(`${"0".repeat(35)}:0`); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  where.range = `http://127.0.0.1:${(server.address() as AddressInfo).port}/range/`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

describe("the actions before sign-in, when the work behind them refuses or fails", () => {
  beforeEach(async () => { await resetDb(); fromIp(IP); finish.calls = 0; });

  it("a set-up whose sign-in the finish refused: the password is set, and the answer has nowhere to go", async () => {
    await seedParentSettings(SIGNINS_ON);
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1", status: "invited" });
    expect(await choosePasswordAction("setup", await mintLink(ana.id, "setup"), GOOD, GOOD)).toEqual({ ok: true, message: PASSWORD_COPY.set });
    expect(finish.calls).toBe(1);
    expect(await credentialRows(ana.authUserId)).toHaveLength(1);
  });

  it("the request page's action answers its one sentence when its work throws", async () => {
    expect(await askPasswordLinkAction("ana@example.com")).toEqual({ ok: true, message: PASSWORD_COPY.askAnswer });
  });
});
