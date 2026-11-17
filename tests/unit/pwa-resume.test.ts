import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RESUME_AFTER_MS, watchResume } from "@/app/components/pwa/resume-watch";

/** A document and window that are only what the watcher uses: events, and whether the page is in front. */
function fakePage() {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const win = new EventTarget();
  const page = {
    doc, win, time: 1_000_000, connected: true, refresh: vi.fn(),
    hide() { doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); },
    show() { doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); },
    /** Put the app away for `ms`, then bring it back. */
    away(ms: number) { page.hide(); page.time += ms; page.show(); },
    watch(afterMs?: number) {
      return watchResume(page.refresh, { afterMs, doc, win, now: () => page.time, online: () => page.connected });
    },
  };
  return page;
}

describe("refreshing when the app comes back to the front", () => {
  it("refreshes after a minute or more away", () => {
    const page = fakePage();
    page.watch();
    expect(RESUME_AFTER_MS).toBe(60_000);
    page.away(RESUME_AFTER_MS);
    expect(page.refresh).toHaveBeenCalledTimes(1);
    page.away(3 * 24 * 3_600_000); // days in a pocket
    expect(page.refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a short look elsewhere, or when the page is only shown", () => {
    const page = fakePage();
    page.watch();
    page.away(RESUME_AFTER_MS - 1);
    page.show();
    expect(page.refresh).not.toHaveBeenCalled();
  });

  it("counts from the first moment it was hidden, and each time away on its own", () => {
    const page = fakePage();
    page.watch();
    page.hide(); page.time += 40_000; page.hide(); page.time += 40_000; page.show(); // hidden for 80 seconds in all
    expect(page.refresh).toHaveBeenCalledTimes(1);
    page.away(40_000); page.away(40_000); // two short trips do not add up
    expect(page.refresh).toHaveBeenCalledTimes(1);
  });

  it("takes the time away from the caller when asked", () => {
    const page = fakePage();
    page.watch(5_000);
    page.away(4_999);
    expect(page.refresh).not.toHaveBeenCalled();
    page.away(5_000);
    expect(page.refresh).toHaveBeenCalledTimes(1);
  });

  it("a page that starts hidden (opened in the background) counts from then", () => {
    const page = fakePage();
    page.doc.visibilityState = "hidden";
    page.watch();
    page.time += RESUME_AFTER_MS;
    page.show();
    expect(page.refresh).toHaveBeenCalledTimes(1);
  });

  it("with no connection it waits, and refreshes when the connection returns", () => {
    const page = fakePage();
    page.watch();
    page.connected = false;
    page.away(RESUME_AFTER_MS);
    expect(page.refresh).not.toHaveBeenCalled();
    page.win.dispatchEvent(new Event("online")); // the event came, but the device still says no
    expect(page.refresh).not.toHaveBeenCalled();
    page.connected = true;
    page.win.dispatchEvent(new Event("online"));
    expect(page.refresh).toHaveBeenCalledTimes(1);
    page.win.dispatchEvent(new Event("online")); // nothing is owed any more
    expect(page.refresh).toHaveBeenCalledTimes(1);
  });

  it("a refresh owed while offline is paid on the next return, however short, and not while hidden", () => {
    const page = fakePage();
    page.watch();
    page.connected = false;
    page.away(RESUME_AFTER_MS);
    page.hide();
    page.connected = true;
    page.win.dispatchEvent(new Event("online"));
    expect(page.refresh).not.toHaveBeenCalled(); // nobody is looking
    page.time += 1_000;
    page.show();
    expect(page.refresh).toHaveBeenCalledTimes(1);
  });

  it("a page restored whole from the back-forward store is a return too, counted once", () => {
    const page = fakePage();
    page.watch();
    const restored = () => page.win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    page.hide(); page.time += RESUME_AFTER_MS;
    page.doc.visibilityState = "visible"; // the browser restored the page and said so only with pageshow
    restored();
    expect(page.refresh).toHaveBeenCalledTimes(1);
    page.show(); restored(); // and then the usual event as well
    expect(page.refresh).toHaveBeenCalledTimes(1);
    page.win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false })); // an ordinary first load
    expect(page.refresh).toHaveBeenCalledTimes(1);
  });

  it("stops when told to", () => {
    const page = fakePage();
    const stop = page.watch();
    stop();
    page.away(RESUME_AFTER_MS * 10);
    page.win.dispatchEvent(new Event("online"));
    expect(page.refresh).not.toHaveBeenCalled();
  });
});

describe("the component that does it", () => {
  const source = readFileSync(path.resolve(__dirname, "../../src/app/components/pwa/refresh-on-resume.tsx"), "utf8");
  it("is a client component that refreshes through the router and stops watching when it is removed", () => {
    expect(source.startsWith(`"use client";`)).toBe(true);
    expect(source).toContain("export function RefreshOnResume");
    expect(source).toMatch(/useEffect\(\(\) => watchResume\(\(\) => router\.refresh\(\)/);
  });
});
