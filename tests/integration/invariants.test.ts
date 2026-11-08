import { describe, it, expect, vi } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { guardOf } from "@/lib/guards";

const root = path.resolve(__dirname, "../..");
// Portable stand-in for fs.globSync (not in Node 20 or its types): every actions.ts under a folder.
const actionModules = (dir: string): string[] => {
  const base = path.join(root, dir);
  try {
    return readdirSync(base, { recursive: true })
      .map((f) => String(f).replaceAll("\\", "/"))
      .filter((f) => f === "actions.ts" || f.endsWith("/actions.ts"))
      .map((f) => `${dir}/${f}`);
  } catch {
    return [];
  }
};
const staffModules = actionModules("src/app/staff");
const parentModules = actionModules("src/app/(parent)");

describe("every server action is guarded (spec §7, §12)", () => {
  it("finds the action modules", () => {
    expect(staffModules.length).toBeGreaterThan(0);
  });

  it.each(staffModules)("%s exports only staffAction-wrapped functions with a permission", async (file) => {
    const mod = await import(path.join(root, file));
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      const g = guardOf(value);
      expect(g, `${file} → ${name} is not wrapped in staffAction`).toBeDefined();
      expect(g?.door, `${file} → ${name}`).toBe("staff");
      expect(g?.permission, `${file} → ${name} declares no permission`).toBeTruthy();
    }
  });

  it.each(parentModules.length ? parentModules : ["(none yet)"])("%s exports only parentAction-wrapped functions", async (file) => {
    if (file === "(none yet)") return;
    const mod = await import(path.join(root, file));
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      expect(guardOf(value)?.door, `${file} → ${name}`).toBe("parent");
    }
  });
});
