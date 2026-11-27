import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { ImageResponse } from "next/og";
import { glyphWidthEm, iconText, textWidthEm, ICON_TEXT_MAX } from "@/lib/pwa/icon-text";
import { appLabel, LABEL_MAX } from "@/lib/pwa/label";
import { ICONS, iconArt, iconHref, iconVersion, isIconName } from "@/lib/pwa/icons";
import { monogramFontSize } from "@/lib/pwa/icon-render";
import { buildManifest } from "@/lib/pwa/manifest";

describe("the label under the home-screen icon", () => {
  it("is the club's name when it is 12 characters or fewer", () => {
    expect(LABEL_MAX).toBe(12);
    expect(appLabel({ name: "E2E Boosters", shortName: "E2E" })).toBe("E2E Boosters"); // exactly 12
    expect(appLabel({ name: "FZN Band", shortName: "FZN" })).toBe("FZN Band");
    expect(appLabel({ name: "  Band  ", shortName: "B" })).toBe("Band");
  });
  it("is the club's short name when the name is longer", () => {
    expect(appLabel({ name: "E2E Boosters!", shortName: "E2E" })).toBe("E2E"); // 13
    expect(appLabel({ name: "FZN Band Boosters", shortName: " FZN " })).toBe("FZN");
    expect(appLabel({ name: "Boosters Rocket", shortName: "BR" })).toBe("BR");
  });
  it("counts characters, not bytes, and never comes out empty", () => {
    expect(appLabel({ name: "École Élèves", shortName: "ÉÉ" })).toBe("École Élèves"); // 12 characters
    expect(appLabel({ name: "A club with a long name", shortName: "  " })).toBe("A club with a long name");
  });
});

describe("the text on the icon", () => {
  it("is the club's short name, as typed", () => {
    expect(iconText("BR")).toBe("BR");
    expect(iconText(" FZN ")).toBe("FZN");
    expect(iconText("d-11")).toBe("d-11");
    expect(iconText("A&M")).toBe("A&M");
    expect(iconText("ÉCO")).toBe("ÉCO");
    expect(iconText("A B")).toBe("A B");
  });
  it("keeps to four characters, the most the settings page accepts", () => {
    expect(ICON_TEXT_MAX).toBe(4);
    expect(iconText("BOOSTERS")).toBe("BOOS");
    expect(iconText("AB  CD")).toBe("AB");
  });
  it.each([
    ["an emoji", "🚀"], ["a letter and an emoji", "B🚀"], ["Japanese", "日本"], ["Cyrillic", "БР"], ["Greek", "ΑΒ"],
    ["a combining accent", "Á"], ["a soft hyphen", "A­B"], ["a non-breaking space", "A B"], ["a tab", "A\tB"],
    ["a line break", "A\nB"], ["a control character", "A\u0007"], ["a zero-width joiner", "A‍B"], ["nothing", ""], ["spaces", "   "],
  ])("is null (the plain mark) for %s", (_what, shortName) => {
    expect(iconText(shortName)).toBeNull();
  });
  it("measures a line with the font's own widths, and 0 for anything the font lacks", () => {
    expect(glyphWidthEm("W")).toBe(0.945);
    expect(glyphWidthEm("I")).toBe(0.27);
    expect(textWidthEm("BR")).toBeCloseTo(0.68 + 0.672, 5);
    expect(textWidthEm("B🚀")).toBe(0);
    expect(glyphWidthEm("")).toBe(0);
  });
});

/** The font Next.js ships for ImageResponse, read as a font file: which characters it has and how wide each is. */
function bundledFont() {
  const file = path.resolve(__dirname, "../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf");
  const font = readFileSync(file);
  const tables = new Map<string, number>();
  for (let i = 0, n = font.readUInt16BE(4); i < n; i++) tables.set(font.toString("latin1", 12 + i * 16, 16 + i * 16), font.readUInt32BE(20 + i * 16));
  const unitsPerEm = font.readUInt16BE(tables.get("head")! + 18);
  const longMetrics = font.readUInt16BE(tables.get("hhea")! + 34);
  const advance = (glyph: number) => font.readUInt16BE(tables.get("hmtx")! + 4 * Math.min(glyph, longMetrics - 1));
  // The Windows Unicode character map, format 4 (segments of the 16-bit range).
  const cmap = tables.get("cmap")!;
  let sub = -1;
  for (let i = 0, n = font.readUInt16BE(cmap + 2); i < n; i++) {
    const at = cmap + 4 + i * 8, offset = cmap + font.readUInt32BE(at + 4);
    if (font.readUInt16BE(at) === 3 && font.readUInt16BE(at + 2) === 1 && font.readUInt16BE(offset) === 4) sub = offset;
  }
  if (sub < 0) throw new Error("the bundled font has no format 4 character map: this test needs teaching its new layout");
  const segs = font.readUInt16BE(sub + 6), ends = sub + 14, starts = ends + segs + 2, deltas = starts + segs, ranges = deltas + segs;
  const glyphOf = (code: number): number => {
    for (let i = 0; i < segs; i += 2) {
      if (code > font.readUInt16BE(ends + i)) continue;
      const start = font.readUInt16BE(starts + i);
      if (code < start) return 0;
      const range = font.readUInt16BE(ranges + i), delta = font.readInt16BE(deltas + i);
      if (range === 0) return (code + delta) & 0xffff;
      const glyph = font.readUInt16BE(ranges + i + range + 2 * (code - start));
      return glyph ? (glyph + delta) & 0xffff : 0;
    }
    return 0;
  };
  return { widthEm: (code: number) => { const g = glyphOf(code); return g ? advance(g) / unitsPerEm : 0; } };
}

describe("the icon font tables match the font Next.js ships", () => {
  const font = bundledFont();

  it("every character the rule allows is in the font, at the width the rule uses", () => {
    // If this fails after a Next.js upgrade, the bundled font changed: regenerate the tables in src/lib/pwa/icon-text.ts
    // from the font file. A character allowed here but missing from the font makes the server fetch a font from Google.
    const allowed: string[] = [];
    for (let code = 0; code <= 0x2ff; code++) {
      const char = String.fromCodePoint(code), ours = glyphWidthEm(char);
      if (ours === 0) continue;
      allowed.push(char);
      expect(font.widthEm(code), `U+${code.toString(16)} (${char}) is allowed on the icon`).toBe(ours);
    }
    expect(allowed.length).toBeGreaterThan(180);
    for (const char of "ABCXYZabcxyz0189&-+.!' ÉÑÖçß") expect(allowed).toContain(char);
  });

  it("the test's reading of the font is right about what the font lacks", () => {
    expect(font.widthEm(0x65e5)).toBe(0); // 日
    expect(font.widthEm(0x00ad)).toBe(0); // soft hyphen
    expect(font.widthEm(0x41)).toBeGreaterThan(0);
  });
});

describe("the renderer never reaches for the network", () => {
  /** Runs `draw` and returns every address fetched meanwhile, except data: addresses (the renderer loads its own layout engine from one). */
  async function fetchedDuring(draw: () => Promise<unknown>): Promise<string[]> {
    const asked: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("data:")) return new Response(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
      asked.push(url);
      throw new Error(`no network in this test: ${url}`);
    });
    try { await draw(); } finally { spy.mockRestore(); }
    return asked;
  }
  const drawText = (text: string) => new ImageResponse(
    createElement("div", { style: { display: "flex", fontSize: 20, whiteSpace: "nowrap" } }, text), { width: 96, height: 48 }).arrayBuffer();

  it("for any character the rule allows: the font has it, and none is taken for an emoji", async () => {
    // The renderer fetches a font from Google for a character its font lacks, and a picture from a CDN for anything
    // it takes for an emoji. Some plain characters are emoji to Unicode (©, ®, the digits, # and *), so every allowed
    // character is drawn here, between two letters, with the network watched.
    const reached: string[] = [];
    for (let code = 0; code <= 0x2ff; code++) {
      const char = String.fromCodePoint(code);
      if (glyphWidthEm(char) === 0) continue;
      const asked = await fetchedDuring(() => drawText(`A${char}A`));
      if (asked.length) reached.push(`U+${code.toString(16)} (${char}): ${asked.join(", ")}`);
    }
    expect(reached).toEqual([]);
  }, 60_000);

  it("the check above does catch a renderer that goes to the network", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const asked = await fetchedDuring(() => drawText("日本").catch(() => undefined));
    quiet.mockRestore();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]).toContain("fonts.googleapis.com");
  });
});

describe("the letters keep inside their share of the icon", () => {
  const names = ["BR", "E2E", "FZN", "WWWW", "MMMM", "W", "I", "iiii", "@@@@", "ÆÆÆÆ", "d-11", "A B"];
  it.each(Object.entries(ICONS))("%s: any four characters fit the mark's share of the width and the height", (_name, { size, mark }) => {
    for (const text of names) {
      const fontSize = monogramFontSize(text, size, mark);
      expect(fontSize, text).toBeGreaterThan(0);
      expect(fontSize * textWidthEm(text), `${text} is too wide`).toBeLessThanOrEqual(size * mark);
      expect(fontSize * 1.3, `${text} is too tall`).toBeLessThanOrEqual(size * mark);
    }
  });
  it("the icons Android may crop keep their mark inside the middle 60%", () => {
    for (const name of ["icon-192.png", "icon-512.png", "apple-touch-icon.png"] as const) expect(ICONS[name].mark).toBeLessThanOrEqual(0.6);
    expect(ICONS["icon-192.png"].size).toBe(192);
    expect(ICONS["icon-512.png"].size).toBe(512);
    expect(ICONS["apple-touch-icon.png"].size).toBe(180);
  });
});

describe("icon names, art and versions", () => {
  it("answers only its own names", () => {
    for (const name of Object.keys(ICONS)) expect(isIconName(name)).toBe(true);
    for (const name of ["icon-193.png", "icon-192", "../icon-192.png", "toString", "constructor", "__proto__", "", "ICON-192.PNG"]) expect(isIconName(name)).toBe(false);
  });
  it("draws on the club's color with the ink that reads on it", () => {
    expect(iconArt({ shortName: "BR", color: "#5b2a86" })).toEqual({ kind: "monogram", text: "BR", background: "#5b2a86", foreground: "#ffffff" });
    expect(iconArt({ shortName: "BR", color: "#f2c200" })).toMatchObject({ background: "#f2c200", foreground: "#14161a" });
    expect(iconArt({ shortName: "🚀", color: "#003366" })).toEqual({ kind: "plain", background: "#003366", foreground: "#ffffff" });
  });
  it("falls back to the default color for a value that is not a color", () => {
    expect(iconArt({ shortName: "BR", color: "red;}" }).background).toBe("#1e1b4b");
  });
  it("the version changes with the color and the short name, and with nothing else", () => {
    const base = iconVersion({ shortName: "BR", color: "#5b2a86" });
    expect(base).toMatch(/^[0-9a-f]{12}$/);
    expect(iconVersion({ shortName: " BR ", color: "#5B2A86" })).toBe(base);
    expect(iconVersion({ shortName: "BR", color: "#5b2a87" })).not.toBe(base);
    expect(iconVersion({ shortName: "BX", color: "#5b2a86" })).not.toBe(base);
    expect(iconVersion({ shortName: "🚀", color: "#5b2a86" })).not.toBe(base);
    expect(iconHref("icon-192.png", base)).toBe(`/icons/icon-192.png?v=${base}`);
  });
});

describe("the manifest", () => {
  const club = { name: "FZN Band Boosters", shortName: "FZN", color: "#f2c200" };
  const m = buildManifest(club);

  it("names the app after the club and labels it by the label rule", () => {
    expect(m.name).toBe("FZN Band Boosters");
    expect(m.short_name).toBe("FZN");
    expect(buildManifest({ ...club, name: "FZN Band" }).short_name).toBe("FZN Band");
  });
  it("is one app for the whole portal, opened standalone at the root", () => {
    expect(m).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone" });
  });
  it("takes its colors from the look, not the club: the bar's surface, and the page's ground for the splash", () => {
    expect(m).toMatchObject({ theme_color: "#f7f9fd", background_color: "#eceef2" });
  });
  it("lists the 192 and 512 icons for any use and as maskable, by versioned address", () => {
    const v = iconVersion(club);
    expect(m.icons).toEqual([
      { src: `/icons/icon-192.png?v=${v}`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/icons/icon-512.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `/icons/icon-192.png?v=${v}`, sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: `/icons/icon-512.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });
  it("holds no hostname anywhere: whoever installs the portal sets its address", () => {
    const text = JSON.stringify(m);
    expect(text).not.toMatch(/https?:|\/\/|localhost/);
    for (const value of [m.id, m.start_url, m.scope, ...m.icons!.map((i) => i.src)]) expect(value).toMatch(/^\/(?!\/)/);
  });
});
