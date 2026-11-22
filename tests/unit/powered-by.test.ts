import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BRAND_SITE, PoweredBy } from "@/app/components/powered-by";
import { ProductMark } from "@/app/setup/product-mark";

// The badge is the kit's outlined "Powered by" drawn inline: its words are paths, so a screen reader is given the
// link's name as text, and no font, image or color of the file's reaches the page.
const badge = (variant?: "mono" | "color") => renderToStaticMarkup(h(PoweredBy, variant ? { variant } : {}));

describe("the Powered by badge", () => {
  it.each([undefined, "color"] as const)("variant %s: a link to the site named by its words, the drawing hidden", (variant) => {
    const html = badge(variant);
    expect(html.startsWith(`<a class="powered-by${variant === "color" ? " powered-by-color" : ""}" href="${BRAND_SITE}">`)).toBe(true);
    expect(BRAND_SITE).toBe("https://boostersrocket.com");
    // the only text in the link is its name, visually hidden
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).toBe("Powered by Boosters Rocket, at boostersrocket.com");
    expect(html).toContain('<span class="visually-hidden">Powered by Boosters Rocket, at boostersrocket.com</span>');
    expect(html).toMatch(/<svg class="pb-badge" viewBox="0 0 235 24" aria-hidden="true" focusable="false">/);
  });

  it.each([undefined, "color"] as const)("variant %s: outlines only, its inks from the stylesheet", (variant) => {
    const html = badge(variant);
    for (const tag of ["<text", "<tspan", "<image", "<use", "<style", "<script", "<foreignObject"]) expect(html).not.toContain(tag);
    expect(html).not.toMatch(/href="(?!https:\/\/boostersrocket\.com")/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/); // no fixed color: fills come from booster.css's tokens
    expect(html).not.toMatch(/\bid=/); // nothing that could clash when two badges share a page (the gallery)
    for (const part of ["pb-words", "pb-mark", "pb-boosters", "pb-rocket"]) expect(html).toContain(`class="${part}"`);
  });

  it("in one ink it is the kit's open mark, the window cut out; in color the mark on its disc", () => {
    expect(badge()).toContain('fill-rule="evenodd"');
    expect(badge()).not.toContain("pb-disc");
    expect(badge("color")).toContain('class="pb-disc"');
  });
});

describe("the setup pages' product icon", () => {
  it("is the kit's app icon, hidden from assistive technology, its colors from the stylesheet", () => {
    const html = renderToStaticMarkup(h(ProductMark));
    expect(html).toMatch(/^<svg class="product-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(html.match(/<circle /g)).toHaveLength(12); // the eleven puffs of the full trail, and the window
    for (const tone of ["pm-tile", "pm-smoke", "pm-glow", "pm-ember", "pm-flame", "pm-rocket"]) expect(html).toContain(`class="${tone}"`);
  });
});
