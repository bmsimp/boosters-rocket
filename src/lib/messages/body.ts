import { createElement as h, Fragment, type ReactNode } from "react";
import { esc } from "@/lib/mail/messages";

/**
 * A club message's body (spec section 6): the editor's document JSON, kept in `message_version.body` only as
 * checkBody() rebuilt it from its allowlist, and drawn by renderBody() as React elements, never as HTML. Pure, with no
 * database import: the staff form's preview, the staff pages and (slice 3) the parent pages all read it.
 */

export type BodyMark = { type: "bold" } | { type: "italic" } | { type: "underline" } | { type: "link"; attrs: { href: string } };
export type BodyInline = { type: "text"; text: string; marks?: BodyMark[] } | { type: "hardBreak" };
export type BodyListItem = { type: "listItem"; content: BodyBlock[] };
export type BodyBlock =
  | { type: "paragraph"; content?: BodyInline[] }
  | { type: "heading"; attrs: { level: 2 | 3 }; content?: BodyInline[] }
  | { type: "bulletList"; content: BodyListItem[] }
  | { type: "orderedList"; attrs?: { start: number }; content: BodyListItem[] }
  | { type: "image"; attrs: { attachment: string; alt: string | null } };
export type MessageBody = { type: "doc"; content: BodyBlock[] };

/** A body with nothing in it, as the editor starts. */
export const EMPTY_BODY: MessageBody = { type: "doc", content: [{ type: "paragraph" }] };

/** At most this much JSON (100 KB) and this much text in one body. */
export const BODY_MAX_BYTES = 100 * 1024;
export const BODY_MAX_TEXT = 20_000;
export const LINK_MAX = 2_000;
export const ALT_MAX = 300;
const MAX_DEPTH = 12;

export type BodyCheck =
  | { ok: true; body: MessageBody; pictures: string[]; textLength: number }
  | { ok: false; error: string };

const OFF_LIST = "The message has something the editor doesn't offer (only headings, bold, italic, underline, lists, links and pictures are kept). Remove it and try again.";
const BAD_LINK = "A link must be a full address starting with https://, http:// or mailto:, of at most 2,000 characters.";
const BAD_PICTURE = "A picture in the message isn't one uploaded to it. Add it again with Add picture.";
const TOO_LONG = "The message is too long: it can hold at most 20,000 characters.";
const TOO_BIG = "The message is too long to save. Make it shorter.";

class Refused extends Error {}
const refuse = (why: string): never => { throw new Refused(why); };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The node's own keys, refused when there is one the node doesn't take; `attrs` checked the same way: a key off the
 * list is refused when it carries a value, and ignored when it is null (the editor writes its defaults so).
 */
function keysOf(node: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(node)) if (!allowed.includes(k)) refuse(OFF_LIST);
}
function attrsOf(node: Record<string, unknown>, allowed: string[]): Record<string, unknown> {
  if (node.attrs === undefined) return {};
  if (!isObject(node.attrs)) return refuse(OFF_LIST);
  for (const [k, v] of Object.entries(node.attrs)) if (!allowed.includes(k) && v !== null) refuse(OFF_LIST);
  return node.attrs;
}
function arrayOf(v: unknown, required: boolean): unknown[] {
  if (v === undefined && !required) return [];
  if (!Array.isArray(v)) return refuse(OFF_LIST);
  return v;
}

/** A link's address, if it may be kept: a full https, http or mailto address, parsed, at most 2,000 characters. */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > LINK_MAX) return null;
  let url: URL;
  try { url = new URL(s); } catch { return null; }
  if (!["https:", "http:", "mailto:"].includes(url.protocol)) return null;
  const href = url.href;
  return href.length <= LINK_MAX ? href : null;
}

type State = { text: number; pictures: string[]; allowed: ReadonlySet<string> };

function checkMarks(v: unknown): BodyMark[] {
  const out: BodyMark[] = [];
  for (const m of arrayOf(v, false)) {
    if (!isObject(m)) return refuse(OFF_LIST);
    keysOf(m, ["type", "attrs"]);
    if (out.some((x) => x.type === m.type)) continue;
    if (m.type === "bold" || m.type === "italic" || m.type === "underline") { attrsOf(m, []); out.push({ type: m.type }); continue; }
    if (m.type === "link") {
      // A link keeps its address alone: every other attribute (target, rel, class) is dropped.
      const href = safeHref(isObject(m.attrs) ? m.attrs.href : undefined);
      if (!href) return refuse(BAD_LINK);
      out.push({ type: "link", attrs: { href } });
      continue;
    }
    return refuse(OFF_LIST);
  }
  return out;
}

function checkInline(v: unknown, s: State): BodyInline[] {
  const out: BodyInline[] = [];
  for (const n of arrayOf(v, false)) {
    if (!isObject(n)) return refuse(OFF_LIST);
    if (n.type === "hardBreak") { keysOf(n, ["type", "attrs", "marks"]); attrsOf(n, []); out.push({ type: "hardBreak" }); continue; }
    if (n.type !== "text") return refuse(OFF_LIST);
    keysOf(n, ["type", "text", "marks"]);
    if (typeof n.text !== "string") return refuse(OFF_LIST);
    // Control characters other than a tab are dropped (Postgres's jsonb can't hold a NUL at all).
    const text = n.text.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, "");
    const marks = checkMarks(n.marks);
    if (!text) continue;
    s.text += text.length;
    if (s.text > BODY_MAX_TEXT) refuse(TOO_LONG);
    out.push(marks.length ? { type: "text", text, marks } : { type: "text", text });
  }
  return out;
}

function checkListItems(v: unknown, s: State, depth: number): BodyListItem[] {
  const items = arrayOf(v, true);
  if (items.length === 0) refuse(OFF_LIST);
  return items.map((n) => {
    if (!isObject(n) || n.type !== "listItem") return refuse(OFF_LIST);
    keysOf(n, ["type", "attrs", "content"]);
    attrsOf(n, []);
    const content = checkBlocks(n.content, s, depth + 1);
    if (content.length === 0) refuse(OFF_LIST);
    return { type: "listItem" as const, content };
  });
}

function checkBlocks(v: unknown, s: State, depth: number): BodyBlock[] {
  if (depth > MAX_DEPTH) refuse(OFF_LIST);
  const out: BodyBlock[] = [];
  for (const n of arrayOf(v, true)) {
    if (!isObject(n)) return refuse(OFF_LIST);
    switch (n.type) {
      case "paragraph": {
        keysOf(n, ["type", "attrs", "content"]);
        attrsOf(n, []);
        const content = checkInline(n.content, s);
        out.push(content.length ? { type: "paragraph", content } : { type: "paragraph" });
        break;
      }
      case "heading": {
        keysOf(n, ["type", "attrs", "content"]);
        const level = attrsOf(n, ["level"]).level;
        if (level !== 2 && level !== 3) return refuse(OFF_LIST);
        const content = checkInline(n.content, s);
        out.push(content.length ? { type: "heading", attrs: { level }, content } : { type: "heading", attrs: { level } });
        break;
      }
      case "bulletList": {
        keysOf(n, ["type", "attrs", "content"]);
        attrsOf(n, []);
        out.push({ type: "bulletList", content: checkListItems(n.content, s, depth) });
        break;
      }
      case "orderedList": {
        keysOf(n, ["type", "attrs", "content"]);
        const start = attrsOf(n, ["start"]).start;
        if (start !== undefined && start !== null && !(Number.isInteger(start) && (start as number) >= 0 && (start as number) <= 9999)) return refuse(OFF_LIST);
        const content = checkListItems(n.content, s, depth);
        out.push(typeof start === "number" && start !== 1 ? { type: "orderedList", attrs: { start }, content } : { type: "orderedList", content });
        break;
      }
      case "image": {
        keysOf(n, ["type", "attrs"]);
        // A picture is the id of a file uploaded to this message, never an address: an image with `src` is refused.
        const a = attrsOf(n, ["attachment", "alt"]);
        if (typeof a.attachment !== "string" || !s.allowed.has(a.attachment)) return refuse(BAD_PICTURE);
        if (a.alt !== undefined && a.alt !== null && typeof a.alt !== "string") return refuse(OFF_LIST);
        const alt = typeof a.alt === "string" ? [...a.alt.trim()].slice(0, ALT_MAX).join("") || null : null;
        if (!s.pictures.includes(a.attachment)) s.pictures.push(a.attachment);
        out.push({ type: "image", attrs: { attachment: a.attachment, alt } });
        break;
      }
      default:
        return refuse(OFF_LIST);
    }
  }
  return out;
}

/**
 * The body as it may be stored, rebuilt from the allowlist, or why it can't be. `pictures`: the ids of the pictures
 * uploaded to this message (held by the poster, or already in its current version), the only images the body may hold;
 * the result lists those it holds, in order.
 */
export function checkBody(input: unknown, pictures: ReadonlySet<string>): BodyCheck {
  let size: number;
  try { size = new TextEncoder().encode(JSON.stringify(input) ?? "").byteLength; } catch { return { ok: false, error: OFF_LIST }; }
  if (size > BODY_MAX_BYTES) return { ok: false, error: TOO_BIG };
  const s: State = { text: 0, pictures: [], allowed: pictures };
  try {
    if (!isObject(input) || input.type !== "doc") return refuse(OFF_LIST);
    keysOf(input, ["type", "attrs", "content"]);
    attrsOf(input, []);
    const content = checkBlocks(input.content, s, 0);
    return { ok: true, body: { type: "doc", content: content.length ? content : EMPTY_BODY.content }, pictures: s.pictures, textLength: s.text };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * A stored body as it is drawn: checked again on the way out against its version's own pictures, so a row changed
 * outside the portal still draws only what the allowlist names (nothing, when it no longer passes).
 */
export function storedBody(json: unknown, pictures: Iterable<string>): MessageBody {
  const r = checkBody(json, new Set(pictures));
  return r.ok ? r.body : EMPTY_BODY;
}

// --- drawing ---------------------------------------------------------------------------------------------------

export type RenderOptions = {
  /** The address a picture is fetched from: the staff file route or (slice 3) the parent's. */
  fileHref: (id: string) => string;
};

/** What a link's address reads as beside its words: a mailto's address alone. */
const shownAddress = (href: string) => {
  if (!href.startsWith("mailto:")) return href;
  try { return decodeURIComponent(href.slice(7)); } catch { return href.slice(7); }
};
const sameAddress = (text: string, href: string) => {
  const t = text.trim().replace(/\/$/, ""), a = shownAddress(href).replace(/\/$/, "");
  return t === a || t === href.replace(/\/$/, "") || `https://${t}` === a || `http://${t}` === a;
};

function drawText(n: Extract<BodyInline, { type: "text" }>, key: string): ReactNode {
  let el: ReactNode = n.text;
  for (const m of n.marks ?? []) {
    if (m.type === "bold") el = h("strong", null, el);
    else if (m.type === "italic") el = h("em", null, el);
    else if (m.type === "underline") el = h("u", null, el);
  }
  return h(Fragment, { key }, el);
}

const linkOf = (n: BodyInline): string | null =>
  n.type === "text" ? (n.marks?.find((m) => m.type === "link") as { attrs: { href: string } } | undefined)?.attrs.href ?? null : null;

/**
 * A run of inline nodes: text with its marks, line breaks, and each run of text under one link drawn as one `<a>`,
 * with its address after it when its words differ from it, so a reader sees where it goes.
 */
function drawInline(nodes: BodyInline[] | undefined, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const list = nodes ?? [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    if (n.type === "hardBreak") { out.push(h("br", { key: `${key}.${i}` })); continue; }
    const href = linkOf(n);
    if (!href) { out.push(drawText(n, `${key}.${i}`)); continue; }
    const run: Extract<BodyInline, { type: "text" }>[] = [];
    let j = i;
    while (j < list.length && linkOf(list[j]!) === href) run.push(list[j++] as Extract<BodyInline, { type: "text" }>);
    const words = run.map((r) => r.text).join("");
    out.push(h("a", { key: `${key}.${i}`, href, rel: "noopener noreferrer" }, run.map((r, k) => drawText(r, `${k}`))));
    if (!sameAddress(words, href)) out.push(h("span", { key: `${key}.${i}a`, className: "msg-link-address" }, ` (${shownAddress(href)})`));
    i = j - 1;
  }
  return out;
}

function drawBlocks(blocks: BodyBlock[], o: RenderOptions, key: string): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}.${i}`;
    switch (b.type) {
      case "paragraph": return h("p", { key: k }, ...drawInline(b.content, k));
      case "heading": return h(b.attrs.level === 2 ? "h3" : "h4", { key: k }, ...drawInline(b.content, k));
      case "bulletList": return h("ul", { key: k }, b.content.map((li, j) => h("li", { key: j }, ...drawBlocks(li.content, o, `${k}.${j}`))));
      case "orderedList": return h("ol", { key: k, start: b.attrs?.start }, b.content.map((li, j) => h("li", { key: j }, ...drawBlocks(li.content, o, `${k}.${j}`))));
      case "image": return h("img", { key: k, src: o.fileHref(b.attrs.attachment), alt: b.attrs.alt ?? "Picture", loading: "lazy", className: "msg-picture" });
    }
  });
}

/**
 * A checked body as React elements, every piece of text a text node. The editor's headings (levels 2 and 3) are drawn
 * one level down (`h3`, `h4`), under the message's own title. Never HTML, never dangerouslySetInnerHTML.
 */
export function renderBody(body: MessageBody, o: RenderOptions): ReactNode {
  return h("div", { className: "msg-body" }, ...drawBlocks(body.content, o, "b"));
}

// --- mail --------------------------------------------------------------------------------------------------------

/** What a picture becomes in a mail: a line pointing to the portal, since a mail carries no image and loads nothing. */
export const MAIL_PICTURE_LINE = "There's a picture here: view it in the portal.";

const MAIL_P = `<p style="margin:0 0 16px">`;
const MAIL_HEADING: Record<2 | 3, string> = { 2: `<h2 style="margin:0 0 12px;font-size:18px">`, 3: `<h3 style="margin:0 0 12px;font-size:16px">` };

/** A run of inline nodes in a mail: text with its marks, line breaks, and a link's words with its address after them when they differ. */
function mailInline(nodes: BodyInline[] | undefined): { text: string; html: string } {
  let text = "", html = "";
  const list = nodes ?? [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    if (n.type === "hardBreak") { text += "\n"; html += "<br>"; continue; }
    const href = linkOf(n);
    if (!href) {
      text += n.text;
      html += marked(n);
      continue;
    }
    const run: Extract<BodyInline, { type: "text" }>[] = [];
    let j = i;
    while (j < list.length && linkOf(list[j]!) === href) run.push(list[j++] as Extract<BodyInline, { type: "text" }>);
    const words = run.map((r) => r.text).join("");
    const after = sameAddress(words, href) ? "" : ` (${shownAddress(href)})`;
    text += `${words}${after}`;
    html += `<a href="${esc(href)}">${run.map(marked).join("")}</a>${esc(after)}`;
    i = j - 1;
  }
  return { text, html };
}

/** One piece of text in a mail's HTML, escaped, inside its marks' tags. */
function marked(n: Extract<BodyInline, { type: "text" }>): string {
  let s = esc(n.text);
  for (const m of n.marks ?? []) {
    if (m.type === "bold") s = `<strong>${s}</strong>`;
    else if (m.type === "italic") s = `<em>${s}</em>`;
    else if (m.type === "underline") s = `<u>${s}</u>`;
  }
  return s;
}

function mailBlocks(blocks: BodyBlock[], indent: string, inList = false): { text: string[]; html: string } {
  const p = inList ? `<p style="margin:0 0 4px">` : MAIL_P;
  const text: string[] = [];
  let html = "";
  for (const b of blocks) {
    switch (b.type) {
      case "paragraph": {
        const r = mailInline(b.content);
        if (!r.text.trim()) break;
        text.push(r.text); html += `${p}${r.html}</p>`;
        break;
      }
      case "heading": {
        const r = mailInline(b.content);
        if (!r.text.trim()) break;
        text.push(r.text); html += `${MAIL_HEADING[b.attrs.level]}${r.html}</h${b.attrs.level}>`;
        break;
      }
      case "bulletList":
      case "orderedList": {
        const start = b.type === "orderedList" ? b.attrs?.start ?? 1 : 0;
        const items = b.content.map((li, k) => {
          const inner = mailBlocks(li.content, `${indent}   `, true);
          const lead = b.type === "orderedList" ? `${start + k}. ` : "- ";
          // A nested list's lines come indented already; anything else after the item's first line lines up under its words.
          const [first = "", ...rest] = inner.text;
          const lines = [`${indent}${lead}${first.trimStart()}`, ...rest.map((t) => (t.startsWith(`${indent}   `) ? t : `${indent}   ${t}`))];
          return { text: lines.join("\n"), html: `<li>${inner.html}</li>` };
        });
        text.push(items.map((x) => x.text).join("\n"));
        const tag = b.type === "orderedList" ? "ol" : "ul";
        html += `<${tag} style="margin:0 0 16px"${b.type === "orderedList" && start !== 1 ? ` start="${start}"` : ""}>${items.map((x) => x.html).join("")}</${tag}>`;
        break;
      }
      case "image":
        text.push(MAIL_PICTURE_LINE); html += `${p}<em>${esc(MAIL_PICTURE_LINE)}</em></p>`;
        break;
    }
  }
  return { text, html };
}

/**
 * A checked body as a mail draws it (spec section 6): plain text, and HTML in which every piece of text and every
 * attribute goes through the mail's esc(). Each picture is a line pointing to the portal: no image, nothing loaded.
 * Never Tiptap's HTML output.
 */
export function bodyMail(body: MessageBody): { text: string; html: string } {
  const r = mailBlocks(body.content, "");
  return { text: r.text.join("\n\n"), html: r.html };
}
