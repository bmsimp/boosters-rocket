import type { MailMessage } from "@/lib/mail/types";
import type { ClubTemplates } from "./catalog";

/**
 * The club's side of every mail: its name and color for the frame, and what the email templates read
 * (docs/superpowers/specs/2026-11-28-email-templates-design.md): the portal's address and the club's contact for the
 * fields of the same names, and the club's own words for each email it changed (`templates`). An email the club never
 * changed, or a caller that gives none, is sent with its default words. Pure: currentBrand() (src/lib/mail/send.ts) reads it.
 */
export type Brand = { clubName: string; color: string; portal?: string; contact?: string | null; templates?: ClubTemplates };

/** Escapes text for HTML: every piece of text and every attribute a mail holds goes through it. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const COLOR = /^#[0-9a-f]{6}$/i;

/**
 * A line of a mail: a sentence, or a link alone on its line (`{ link }`: a set-up, reset or confirm link). The plain
 * text holds the link's address alone on its line, never wrapped; the HTML holds it as an anchor whose text is the whole
 * address and whose href is the same address, escaped once, with nothing added, in a paragraph of its own.
 */
export type Line = string | { link: string };
export const PARAGRAPH = `<p style="margin:0 0 16px">`;

/**
 * The footer of every mail the portal sends (brand/BRAND.md, co-branding: the club leads, the product is a "Powered by"
 * line). Words only: no image, no link, so a sign-in mail carries no address but its own and nothing is fetched.
 */
export const POWERED_BY = "Powered by Boosters Rocket";
/** The footer in HTML: the brand's badge ink, with the product's name in Launch Indigo (brand/tokens.css). */
const POWERED_BY_HTML = `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e3e4e8;font-size:13px;color:#6b6b6b">`
  + `Powered by <span style="color:#1e1b4b;font-weight:bold">Boosters Rocket</span></p>`;

/** The frame of every mail: a colored bar with the club name, the mail's own HTML, then the "Powered by" line. */
export function frame(b: Pick<Brand, "clubName" | "color">, inner: string): string {
  const color = COLOR.test(b.color) ? b.color : "#1e1b4b";
  return `<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">`
    + `<div style="background:${color};color:#ffffff;padding:16px 24px;font-size:18px;font-weight:bold">${esc(b.clubName)}</div>`
    + `<div style="padding:24px">${inner}${POWERED_BY_HTML}</div></body></html>`;
}

/**
 * One block of a mail, drawn both ways: its plain text (null where the plain text leaves it out, as the big code is) and
 * its HTML. A mail is its blocks, the text ones joined by a blank line, and the HTML in the frame.
 */
export type Block = {
  text: string | null; html: string;
  /** For a block with no text of its own: a line the plain text takes when no other block's text holds `holds` (the code). */
  textUnlessHeld?: { line: string; holds: string };
};

export const lineHtml = (p: Line) => (typeof p === "string" ? `${PARAGRAPH}${esc(p)}</p>` : `${PARAGRAPH}<a href="${esc(p.link)}">${esc(p.link)}</a></p>`);
/** Lines as blocks: each its own paragraph, a link alone on its line. */
export const lines = (ls: Line[]): Block[] => ls.map((l) => ({ text: typeof l === "string" ? l : l.link, html: lineHtml(l) }));
/**
 * A code shown big at the head of the HTML. The plain text has it in its sentence; where the club's words leave that
 * sentence out, the plain text takes a line of its own, so the code is never in the subject alone.
 */
export const bigCode = (code: string): Block => ({ text: null, textUnlessHeld: { line: `Your code is ${code}.`, holds: code },
  html: `<p style="margin:0 0 16px;font-size:32px;letter-spacing:6px;font-weight:bold">${esc(code)}</p>` });

/** The plain text of a mail's blocks, then the "Powered by" line. */
export const mailText = (blocks: Block[]) => {
  const held = (x: string) => blocks.some((b) => b.text?.includes(x));
  const texts = blocks.flatMap((b) => (b.text !== null ? [b.text] : b.textUnlessHeld && !held(b.textUnlessHeld.holds) ? [b.textUnlessHeld.line] : []));
  return `${texts.join("\n\n")}\n\n-- \n${POWERED_BY}\n`;
};
/** The HTML of a mail's blocks, in the club's frame. */
export const mailHtml = (b: Pick<Brand, "clubName" | "color">, blocks: Block[]) => frame(b, blocks.map((x) => x.html).join(""));

export type { MailMessage };
