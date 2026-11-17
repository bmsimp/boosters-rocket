import { readdirSync } from "node:fs";

/**
 * The parent pages as the browser asks for them, found on disk, for tests/e2e/parent-session.spec.ts and
 * parent-a11y.spec.ts: a new page is covered without being listed. A page with a dynamic segment can't be asked for
 * without params, so tests/e2e/parent-params.ts keeps a small map of them, and paramsProblems() says exactly what to
 * add when a new dynamic page has none.
 * No Playwright here, so tests/unit/e2e-parent-routes.test.ts can run these on folders it makes up.
 */
export const PARENT_DIR = "src/app/(parent)";

export type RouteParams = Record<string, string | string[]>;
/**
 * `own` asks for something of the signed-in family: the page must answer 200. `other` asks for the same kind of thing
 * in another family: whatever the page answers, it must send nothing of theirs.
 */
export type DynamicRouteParams = { own: RouteParams; other: RouteParams };

/** "students/[id]/page.tsx" is the route "/students/[id]": route groups in (parentheses) are not part of the address. */
export function parentRoutes(dir = PARENT_DIR): string[] {
  return readdirSync(dir, { recursive: true }).map((f) => String(f).replaceAll("\\", "/"))
    .filter((f) => /(^|\/)page\.(tsx|ts|jsx|js)$/.test(f))
    .map((f) => `/${f.split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).join("/")}`)
    .sort();
}

export const isDynamic = (route: string) => route.includes("[");

/** What to add for each dynamic route that has no params, and what to remove for each entry whose page is gone. Empty when the map is right. */
export function paramsProblems(routes: string[], params: Record<string, DynamicRouteParams>): string[] {
  const missing = routes.filter((route) => isDynamic(route) && !params[route]).map((route) =>
    `The parent page ${route} has a dynamic segment and no params to ask for it with, so nothing checks what it sends to the browser. `
    + `Add it to PARAMS in tests/e2e/parent-params.ts with ids from scripts/seed-e2e.ts, for example `
    + `"/students/[id]": { own: { id: "E2E-S1" }, other: { id: "E2E-S3" } }: \`own\` belongs to the family E2E-FAMILY, \`other\` to another family.`);
  const gone = Object.keys(params).filter((route) => !routes.includes(route)).map((route) =>
    `PARAMS in tests/e2e/parent-params.ts names ${route}, which is not a parent page with a dynamic segment any more. Remove it.`);
  const plain = Object.keys(params).filter((route) => routes.includes(route) && !isDynamic(route)).map((route) =>
    `PARAMS in tests/e2e/parent-params.ts names ${route}, which has no dynamic segment. Remove it.`);
  return [...missing, ...gone, ...plain];
}

/** The address of a route with its params filled in: "/students/[id]" with { id: "E2E-S1" } is "/students/E2E-S1". */
export function addressOf(route: string, params: RouteParams = {}): string {
  const need = (name: string) => {
    const value = params[name];
    if (value === undefined || value.length === 0) throw new Error(`The route ${route} needs the param "${name}", and the params given have ${Object.keys(params).join(", ") || "none"}.`);
    return [value].flat().map(encodeURIComponent);
  };
  const segments = route.split("/").filter(Boolean).flatMap((segment) => {
    const optional = /^\[\[\.\.\.(.+)\]\]$/.exec(segment)?.[1];
    if (optional) return [params[optional] ?? []].flat().map(encodeURIComponent);
    const name = /^\[(?:\.\.\.)?(.+)\]$/.exec(segment)?.[1];
    return name ? need(name) : [segment];
  });
  return `/${segments.join("/")}`;
}
