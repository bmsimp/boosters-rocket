import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { inflateSync } from "node:zlib";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { ICONS, iconVersion, type IconName } from "@/lib/pwa/icons";
import { forgetRenderedIcons } from "@/lib/pwa/icon-render";
import { isSquarePng, plainIconPng } from "@/lib/pwa/plain-icon";
import { GET } from "@/app/icons/[name]/route";
import manifest, { dynamic as manifestDynamic } from "@/app/manifest";
import { resetDb } from "../helpers/db";

const CLUB = { name: "FZN Band Boosters", shortName: "FZN", color: "#f2c200", treasurerEmail: null };
const saveClub = (value: Record<string, unknown>) => db.insert(setting).values({ key: "club", value })
  .onConflictDoUpdate({ target: setting.key, set: { value } });

const ask = (name: string, o: { v?: string; headers?: Record<string, string> } = {}) =>
  GET(new Request(`http://portal.example/icons/${name}${o.v === undefined ? "" : `?v=${o.v}`}`, { headers: o.headers }), { params: Promise.resolve({ name }) });
const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** Every fetch the server makes while the icons are drawn. The renderer loads its own layout engine from a data: address, which is not the network. */
function watchNetwork() {
  const asked: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("data:")) return new Response(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
    asked.push(url);
    throw new Error(`the icon renderer reached for the network: ${url}`);
  });
  return { asked, restore: () => spy.mockRestore() };
}

describe("the club's app icons", () => {
  let network: ReturnType<typeof watchNetwork>;
  beforeEach(async () => { await resetDb(); forgetRenderedIcons(); network = watchNetwork(); });
  afterEach(() => { network.restore(); });

  it.each(Object.entries(ICONS) as [IconName, { size: number }][])("%s is a PNG of its stated size, drawn without the network", async (name, { size }) => {
    await saveClub(CLUB);
    const res = await ask(name);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = await bytesOf(res);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(pngSize(png)).toEqual({ width: size, height: size });
    expect(network.asked).toEqual([]);
  });

  it("draws the default club before anything is saved (setup still open)", async () => {
    const res = await ask("icon-192.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${iconVersion({ shortName: "BR", color: "#1e1b4b" })}"`);
    expect(isSquarePng(await bytesOf(res), 192)).toBe(true);
  });

  it.each(["icon-193.png", "icon-192", "favicon.ico", "..%2Ficon-192.png", "constructor", "ICON-192.PNG", ""])("answers 404 for %j", async (name) => {
    const res = await ask(name);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("can be kept for good at its versioned address, and is checked again at any other", async () => {
    await saveClub(CLUB);
    const version = iconVersion(CLUB);
    const current = await ask("icon-512.png", { v: version });
    expect(current.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(current.headers.get("etag")).toBe(`"${version}"`);
    for (const v of [undefined, "", "000000000000", `${version}x`]) {
      const other = await ask("icon-512.png", { v });
      expect(other.status).toBe(200);
      expect(other.headers.get("cache-control"), String(v)).toBe("no-cache");
      expect((await bytesOf(other)).equals(await bytesOf(await ask("icon-512.png", { v: version })))).toBe(true); // the value asked with changes nothing drawn
    }
  });

  it("answers 304 to a browser that already has this version", async () => {
    await saveClub(CLUB);
    const etag = `"${iconVersion(CLUB)}"`;
    const res = await ask("icon-192.png", { headers: { "if-none-match": etag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect((await ask("icon-192.png", { headers: { "if-none-match": `"old"` } })).status).toBe(200);
  });

  it("changes, with its version, when the club changes its color or short name", async () => {
    await saveClub(CLUB);
    const before = await ask("icon-192.png");
    await saveClub({ ...CLUB, color: "#003366" });
    const recolored = await ask("icon-192.png");
    await saveClub({ ...CLUB, color: "#003366", shortName: "FB" });
    const renamed = await ask("icon-192.png");
    const etags = [before, recolored, renamed].map((r) => r.headers.get("etag"));
    expect(new Set(etags).size).toBe(3);
    const pngs = await Promise.all([before, recolored, renamed].map(bytesOf));
    expect(pngs[0]!.equals(pngs[1]!)).toBe(false);
    expect(pngs[1]!.equals(pngs[2]!)).toBe(false);
  });

  it("draws the plain mark, without the letter renderer, for a short name the icon font can't draw", async () => {
    await saveClub({ ...CLUB, shortName: "日本" });
    const res = await ask("icon-192.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache"); // a real icon, not a stand-in: it has a version
    const png = await bytesOf(res);
    expect(png.equals(plainIconPng(192, "#f2c200", "#14161a", 0.6))).toBe(true);
    expect(network.asked).toEqual([]);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled(); // not even the renderer's own engine was loaded
  });

  it("keeps a drawn icon in memory: the second answer is the same bytes without drawing again", async () => {
    await saveClub(CLUB);
    const first = await bytesOf(await ask("icon-512.png"));
    const calls = vi.mocked(globalThis.fetch).mock.calls.length;
    const second = await bytesOf(await ask("icon-512.png"));
    expect(second.equals(first)).toBe(true);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(calls);
  });
});

describe("the plain mark", () => {
  /** The pixels of a PNG made by plainIconPng: 8-bit RGB rows, each after a filter byte. */
  const pixels = (png: Buffer, size: number) => {
    const raw = inflateSync(png.subarray(png.indexOf("IDAT") + 4, png.lastIndexOf("IEND") - 8));
    return (x: number, y: number) => `#${raw.subarray(y * (1 + size * 3) + 1 + x * 3, y * (1 + size * 3) + 4 + x * 3).toString("hex")}`;
  };

  it.each([[192, 0.6], [512, 0.6], [180, 0.6], [48, 0.84]])("at %ipx is a valid PNG of that size: the club's color with the mark inside its share", (size, mark) => {
    const png = plainIconPng(size, "#5b2a86", "#ffffff", mark);
    expect(isSquarePng(png, size)).toBe(true);
    const at = pixels(png, size);
    expect(at(0, 0)).toBe("#5b2a86");
    expect(at(size - 1, size - 1)).toBe("#5b2a86");
    expect(at(size / 2, size / 2)).toBe("#ffffff"); // the dot
    // Nothing is drawn outside the mark's share of the icon.
    const edge = Math.floor((size * (1 - mark)) / 2) - 1;
    for (let i = 0; i < size; i++) for (const [x, y] of [[i, edge], [edge, i], [i, size - 1 - edge], [size - 1 - edge, i]] as const) expect(at(x, y)).toBe("#5b2a86");
  });
});

describe("when the letter renderer fails", () => {
  beforeEach(async () => { await resetDb(); vi.resetModules(); });
  afterEach(() => { vi.doUnmock("next/og"); vi.restoreAllMocks(); });

  it("the icon is still a real PNG (the plain mark), marked not to be kept, and the failure is logged", async () => {
    // What a broken renderer looks like from outside: the response exists, and reading its body fails.
    vi.doMock("next/og", () => ({ ImageResponse: class { arrayBuffer() { return Promise.reject(new Error("wasm missing")); } } }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await saveClub(CLUB);
    const { GET: get } = await import("@/app/icons/[name]/route");
    const res = await get(new Request("http://portal.example/icons/icon-192.png?v=whatever"), { params: Promise.resolve({ name: "icon-192.png" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
    expect((await bytesOf(res)).equals(plainIconPng(192, "#f2c200", "#14161a", 0.6))).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("an answer that is not a PNG of the size asked for counts as a failure", async () => {
    vi.doMock("next/og", () => ({ ImageResponse: class { arrayBuffer() { return Promise.resolve(new TextEncoder().encode("<html>error</html>").buffer); } } }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await saveClub(CLUB);
    const { GET: get } = await import("@/app/icons/[name]/route");
    const res = await get(new Request("http://portal.example/icons/icon-512.png"), { params: Promise.resolve({ name: "icon-512.png" }) });
    expect(isSquarePng(await bytesOf(res), 512)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("tries the letters again after a few minutes, not on every request", async () => {
    let fail = true, draws = 0;
    vi.doMock("next/og", () => ({ ImageResponse: class {
      arrayBuffer() { draws++; return fail ? Promise.reject(new Error("down")) : Promise.resolve(new Uint8Array(plainIconPng(192, "#000000", "#ffffff", 0.2)).buffer); }
    } }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { renderIcon } = await import("@/lib/pwa/icon-render");
    const club = { shortName: "FZN", color: "#f2c200" };
    expect((await renderIcon("icon-192.png", club, 0)).degraded).toBe(true);
    expect((await renderIcon("icon-192.png", club, 60_000)).degraded).toBe(true);
    expect(draws).toBe(1);
    fail = false;
    expect((await renderIcon("icon-192.png", club, 5 * 60_000)).degraded).toBe(false);
    expect((await renderIcon("icon-192.png", club, 10 * 60_000)).degraded).toBe(false);
    expect(draws).toBe(2);
  });
});

describe("the manifest route", () => {
  beforeEach(resetDb);

  it("is built on each request, from the club's settings as they are now", async () => {
    expect(manifestDynamic).toBe("force-dynamic");
    expect(await manifest()).toMatchObject({ name: "Boosters Rocket", short_name: "BR", theme_color: "#f7f9fd", background_color: "#eceef2" });
    await saveClub(CLUB);
    expect(await manifest()).toMatchObject({ name: "FZN Band Boosters", short_name: "FZN", theme_color: "#f7f9fd", background_color: "#eceef2", start_url: "/", scope: "/", id: "/" });
    await saveClub({ ...CLUB, name: "FZN Boosters" });
    expect((await manifest()).short_name).toBe("FZN Boosters");
  });
});
