import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * v1 spec §12, invariant 5: no secret reaches the browser. scripts/check-client-bundle.mjs searches the built client
 * files for the env's secret values (CI's browser step). This keeps the cause out of the source as well: a client
 * component ("use client") never reads the environment, and imports nothing that holds or reaches a secret (the
 * database, the sealed settings, QuickBooks, Documenso, mail). What a client component shows comes to it as props,
 * which tests/e2e/parent-session.spec.ts reads for other families' data.
 */
const root = path.resolve(__dirname, "../..");
const isClient = (source: string) => /^(["'])use client\1/.test(source.replace(/^﻿/, "").replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, ""));
const clientFiles = readdirSync(path.join(root, "src"), { recursive: true }).map((f) => `src/${String(f).replaceAll("\\", "/")}`)
  .filter((f) => /\.tsx?$/.test(f) && isClient(readFileSync(path.join(root, f), "utf8")));
const SERVER_ONLY = /^@\/(env|lib\/(db|crypto|quickbooks|documenso|mail\/(?!.*types)|settings|auth\/(?!client|provider-fields)|guards|audit\/log|jobs))/;

/** What a client module must not do, as found in its source: read the environment, or import a module that reaches a secret. */
function reachesSecrets(source: string): string[] {
  const found: string[] = [];
  if (/\bprocess\.env\b/.test(source)) found.push("reads process.env");
  for (const m of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) if (SERVER_ONLY.test(m[1]!) || m[1] === "server-only") found.push(`imports ${m[1]}`);
  return found;
}

describe("client components reach no secret (v1 spec §12, invariant 5)", () => {
  it("finds the client components", () => {
    expect(clientFiles.length).toBeGreaterThan(20);
  });

  it("catches a read of the environment and an import of the database or the env, and lets a type import through", () => {
    expect(reachesSecrets('"use client";\nconst k = process.env.BETTER_AUTH_SECRET;')).toEqual(["reads process.env"]);
    expect(reachesSecrets('"use client";\nimport { env } from "@/env";\nimport { db } from "@/lib/db/client";')).toEqual(["imports @/env", "imports @/lib/db/client"]);
    expect(reachesSecrets('"use client";\nimport type { Tx } from "@/lib/db/client";\nimport { safely } from "@/app/components/action-error";')).toEqual([]);
  });

  it("none of them reads the environment or imports a module that holds a secret", () => {
    const found = clientFiles.flatMap((file) => reachesSecrets(readFileSync(path.join(root, file), "utf8")).map((why) => `${file} ${why}`));
    expect(found, "Pass a client component only what it shows, as props from a server component.").toEqual([]);
  });
});
