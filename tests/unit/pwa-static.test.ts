import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import nextConfig from "../../next.config";
import { config as proxyConfig } from "@/proxy";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
/** JavaScript without its comments. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("while setup is open, the proxy leaves the installable-app files alone", () => {
  // Next.js matches a path against each matcher from its first character to its last.
  const matched = (pathname: string) => proxyConfig.matcher.some((m) => new RegExp(`^${m}$`).test(pathname));

  it.each(["/manifest.webmanifest", "/offline.html", "/sw.js", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png",
    "/icons/favicon.png", "/favicon.ico", "/api/health"])("%s is not redirected to /setup", (pathname) => {
    expect(matched(pathname)).toBe(false);
  });

  it.each(["/", "/sign-in", "/display", "/staff/roster", "/offline", "/manifest", "/forms/offline.html", "/staff/manifest.webmanifest",
    "/offline.html/more", "/manifest.webmanifest.html"])("%s still is", (pathname) => {
    expect(matched(pathname)).toBe(true);
  });
});

describe("the service worker stores the offline page and nothing else", () => {
  const sw = code(read("public/sw.js"));

  it("puts one thing in a cache: /offline.html", () => {
    expect(sw.match(/\.put\(/g)).toHaveLength(1);
    expect(sw).toContain("cache.put(OFFLINE_URL, response)");
    expect(sw).toContain(`const OFFLINE_URL = "/offline.html"`);
    expect(sw).not.toMatch(/\.add\(|\.addAll\(/);
  });
  it("refuses to store a redirect or an error under that name", () => {
    expect(sw).toContain(`redirect: "error"`);
    expect(sw).toContain("if (!response.ok) throw");
  });
  it("answers only page loads, and only from the network or the offline page", () => {
    expect(sw).toContain(`if (event.request.mode !== "navigate") return;`);
    expect(sw.match(/respondWith\(/g)).toHaveLength(1);
    expect(sw.match(/caches\.match\(/g)).toHaveLength(1);
    expect(sw).toContain("caches.match(OFFLINE_URL)");
  });
  it("removes caches an older worker left, and loads no other script", () => {
    expect(sw).toContain("if (name !== CACHE) await caches.delete(name)");
    expect(sw).not.toMatch(/importScripts|import\s*\(|\bimport\s/);
  });
});

describe("the offline page is the same for every club and every person", () => {
  const html = read("public/offline.html");

  it("fetches nothing: no script, stylesheet, image, font or address of any site", () => {
    expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|src=|https?:\/\/|\/\/[a-z]/i);
    expect(html).toContain("<style>");
  });
  it("has a Try again control that asks for the same address again", () => {
    expect(html).toMatch(/<a class="btn" href="">Try again<\/a>/);
  });
  it("is a real page for a phone: language, title, viewport that keeps zoom, safe areas", () => {
    expect(html).toContain(`<html lang="en">`);
    expect(html).toContain("<title>You're offline</title>");
    expect(html).toContain(`content="width=device-width, initial-scale=1, viewport-fit=cover"`);
    expect(html).not.toMatch(/user-scalable|maximum-scale/);
    expect(html).toContain("env(safe-area-inset-bottom)");
  });
  it("sets its text in rem and names no club", () => {
    expect(html.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(/font(-size)?:[^;]*\dpx|Booster|club color/i);
  });
});

describe("response headers (next.config.ts)", () => {
  type Rule = { source: string; headers: { key: string; value: string }[] };
  const rules = async () => (await nextConfig.headers!()) as Rule[];
  const of = (rule: Rule) => Object.fromEntries(rule.headers.map((h) => [h.key.toLowerCase(), h.value]));

  it("every answer: no sniffing, a short referrer, and no framing by another site", async () => {
    const all = (await rules()).find((r) => r.source === "/:path*")!;
    expect(of(all)).toEqual({
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY",
    });
  });
  it("sets no rule about what the portal itself may frame or run: the signing frame and a script policy come later", async () => {
    const all = (await rules()).find((r) => r.source === "/:path*")!;
    expect(of(all)["content-security-policy"]).not.toMatch(/frame-src|child-src|default-src|script-src/);
  });
  it("the service worker: JavaScript, never cached, and its own tight policy that keeps the framing rule", async () => {
    const sw = (await rules()).find((r) => r.source === "/sw.js")!;
    expect(of(sw)).toEqual({
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      "content-security-policy": "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
  });
  it("the pages a set-up or reset link opens send no referrer at all, by a rule after the one for every answer", async () => {
    const all = await rules();
    for (const source of ["/sign-in/set-up/:token", "/sign-in/reset/:token"]) {
      const at = all.findIndex((r) => r.source === source);
      expect(at, source).toBeGreaterThan(all.findIndex((r) => r.source === "/:path*"));
      expect(of(all[at]!), source).toEqual({ "referrer-policy": "no-referrer" });
    }
    // Nothing else replaces the rule for every answer.
    expect(all.map((r) => r.source)).toEqual(["/:path*", "/sw.js", "/sign-in/set-up/:token", "/sign-in/reset/:token"]);
  });
  it("does not say what the server is built with, and sends /favicon.ico to the club's icon", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(await nextConfig.rewrites!()).toEqual([{ source: "/favicon.ico", destination: "/icons/favicon.png" }]);
  });
});

describe("the safe-area rules sit in one block at the end of the stylesheet", () => {
  const css = read("src/app/booster.css");
  const start = css.indexOf("/* ===== Installed app:");
  const block = css.slice(start);

  it("is the last thing in the file", () => {
    expect(start).toBeGreaterThan(0);
    expect(css.trimEnd().endsWith("/* ===== end of the installed-app block ===== */")).toBe(true);
    expect(css.slice(0, start)).not.toMatch(/safe-area-inset-(top|left|right)/);
  });
  it.each([
    ["the body clears the home indicator under the tab bar", "body { padding-bottom: calc(88px + env(safe-area-inset-bottom)); }"],
    ["the gutters clear a notch on either side", ".wrap { padding-left: max(var(--cell), env(safe-area-inset-left)); padding-right: max(var(--cell), env(safe-area-inset-right)); }"],
    ["the club bar clears the top", ".bar { padding-top: env(safe-area-inset-top); }"],
    ["the tab bar clears the home indicator and both sides", ".tabs { padding-bottom: env(safe-area-inset-bottom); padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }"],
    ["on a wide screen the body still clears the home indicator", "@media (min-width: 760px) { body { padding-bottom: env(safe-area-inset-bottom); } }"],
  ])("%s", (_what, rule) => {
    expect(block).toContain(rule);
  });
});

describe("where the installed-app pieces are mounted", () => {
  it("the parent layout mounts the refresh on resume, once", () => {
    const layout = code(read("src/app/(parent)/layout.tsx"));
    expect(layout).toContain(`import { RefreshOnResume } from "../components/pwa/refresh-on-resume";`);
    expect(layout.match(/<RefreshOnResume\b/g)).toHaveLength(1);
  });
  it("the sign-in page carries the hint a person can put away, and the Display page the permanent one", () => {
    expect(code(read("src/app/sign-in/page.tsx")).match(/<InstallHint\b[^>]*>/g)).toEqual(["<InstallHint />"]);
    expect(code(read("src/app/(parent)/display/page.tsx")).match(/<InstallHint\b[^>]*>/g)).toEqual(["<InstallHint permanent />"]);
  });
  it("the hint is given nothing but that: no club or family data is passed to it", () => {
    expect(code(read("src/app/components/pwa/install-hint.tsx"))).toContain("export function InstallHint({ permanent = false }: { permanent?: boolean })");
  });
});
