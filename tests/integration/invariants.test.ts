import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { guardOf } from "@/lib/guards";

const root = path.resolve(__dirname, "../..");

// True when the first statement of the source is a "use server" directive (single or double quotes),
// ignoring leading whitespace, a BOM and comments.
const startsWithUseServer = (source: string): boolean => {
  const body = source.replace(/^﻿/, "").replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, "");
  return /^(["'])use server\1/.test(body);
};

// Every .ts/.tsx file under src/ whose first statement is "use server", wherever it lives and whatever it is named.
const serverActionModules = (): string[] =>
  readdirSync(path.join(root, "src"), { recursive: true })
    .map((f) => String(f).replaceAll("\\", "/"))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `src/${f}`)
    .filter((f) => startsWithUseServer(readFileSync(path.join(root, f), "utf8")));

const modules = serverActionModules();
const staffModules = modules.filter((f) => f.startsWith("src/app/staff/"));
const parentModules = modules.filter((f) => f.startsWith("src/app/(parent)/"));
const setupModules = modules.filter((f) => f.startsWith("src/app/setup/"));
const otherModules = modules.filter((f) => !staffModules.includes(f) && !parentModules.includes(f) && !setupModules.includes(f));

const exportedFunctions = async (file: string) => {
  const mod = await import(path.join(root, file));
  return Object.entries(mod).filter(([, v]) => typeof v === "function") as [string, (...a: never[]) => unknown][];
};

describe("every server action is guarded (spec §7, §12)", () => {
  it("finds the server action modules", () => {
    expect(staffModules.length).toBeGreaterThan(0);
  });

  it("recognizes the directive in either quote style", () => {
    expect(startsWithUseServer(`"use server";\nexport async function a() {}`)).toBe(true);
    expect(startsWithUseServer(`// note\n'use server'\nexport async function a() {}`)).toBe(true);
    expect(startsWithUseServer(`import x from "y";\n"use server";`)).toBe(false);
  });

  it.each(staffModules)("%s exports only staffAction-wrapped functions with a permission", async (file) => {
    for (const [name, value] of await exportedFunctions(file)) {
      const g = guardOf(value);
      expect(g, `${file} → ${name} is not wrapped in staffAction`).toBeDefined();
      expect(g?.door, `${file} → ${name}`).toBe("staff");
      expect(g?.permission, `${file} → ${name} declares no permission`).toBeTruthy();
    }
  });

  it.each(parentModules.length ? parentModules : ["(none yet)"])("%s exports only parentAction-wrapped functions", async (file) => {
    if (file === "(none yet)") return;
    for (const [name, value] of await exportedFunctions(file)) {
      expect(guardOf(value)?.door, `${file} → ${name} is not wrapped in parentAction`).toBe("parent");
    }
  });

  it.each(setupModules.length ? setupModules : ["(none yet)"])("%s exports only setup-guarded functions", async (file) => {
    if (file === "(none yet)") return;
    for (const [name, value] of await exportedFunctions(file)) {
      const door = guardOf(value)?.door;
      if (name === "unlockSetupAction") expect(door, `${file} → ${name}`).toBe("setup-unlock");
      else expect(door, `${file} → ${name} is not wrapped in setupAction`).toBe("setup");
    }
  });

  it.each(otherModules.length ? otherModules : ["(none)"])("%s (use server elsewhere) exports only guarded functions", async (file) => {
    if (file === "(none)") return;
    for (const [name, value] of await exportedFunctions(file)) {
      const g = guardOf(value);
      expect(g, `${file} → ${name} is guarded by neither staffAction nor parentAction`).toBeDefined();
      if (g?.door === "staff") expect(g.permission, `${file} → ${name} declares no permission`).toBeTruthy();
    }
  });
});
