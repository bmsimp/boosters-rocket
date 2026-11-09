import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetDb } from "../helpers/db";
import * as original from "@/lib/setup/state";

describe("setup status cache state", () => {
  beforeEach(async () => { await resetDb(); original.clearSetupStatusCache(); });

  it("is shared between separately loaded copies of the module", async () => {
    expect(await original.setupStatusCached()).toBe("open"); // cached by this copy
    vi.resetModules();
    const fresh = await import("@/lib/setup/state");
    expect(fresh).not.toBe(original);
    await fresh.updateSetupState({ status: "finished" }); // clears the cache the other copy filled
    expect(await original.setupStatusCached()).toBe("finished");
    await original.updateSetupState({ status: "open" });
    expect(await fresh.setupStatusCached()).toBe("open");
  });
});
