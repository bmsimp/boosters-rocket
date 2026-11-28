import { esc, PARAGRAPH, type Block } from "./frame";

/*
 * An email template's words (docs/superpowers/specs/2026-11-28-email-templates-design.md, section 2): the subject, a line
 * with fields in braces, and the body, the editor's document with fields and fixed parts in it. Pure, so the server's
 * save, every send, the editor's live preview and its check before saving all read the same rules. Nothing a person
 * writes is ever HTML: each piece of text and each field's value goes through esc().
 */

export type TemplateMark = { type: "bold" } | { type: "italic" } | { type: "underline" } | { type: "link"; attrs: { href: string } };
export type TemplateInline = { type: "text"; text: string; marks?: TemplateMark[] } | { type: "hardBreak" } | { type: "field"; attrs: { id: string } };
export type TemplateParagraph = { type: "paragraph"; content?: TemplateInline[] };
export type TemplateListItem = { type: "listItem"; content: (TemplateParagraph | TemplateList)[] };
export type TemplateList = { type: "bulletList" | "orderedList"; content: TemplateListItem[] };
export type TemplateBlock = TemplateParagraph | TemplateList | { type: "fixedPart"; attrs: { id: string } };
export type TemplateDoc = { type: "doc"; content: TemplateBlock[] };

/** What the check needs to know of one email: its fields (by id and label), its fixed parts, whether links are allowed, and whether its subject is its own. */
export type TemplateRules = {
  fields: readonly { id: string; label: string }[];
  fixed: readonly { id: string; label: string }[];
  links: boolean;
  subjectFixed: boolean;
};

export const TEMPLATE_MAX_BYTES = 20 * 1024;
export const TEMPLATE_MAX_TEXT = 5_000;
export const SUBJECT_MAX = 200;
const LINK_MAX = 2_000;
const MAX_DEPTH = 4;

export const OFF_LIST = "The email has something the editor doesn't offer (only bold, italic, underline, lists, links and fields are kept). Remove it and try again.";
const NO_LINKS = "Sign-in emails can't hold links of their own: the portal adds the one link they need. Remove the link and try again.";
const BAD_LINK = "A link must be a full address starting with https://, http:// or mailto:, of at most 2,000 characters.";
const TOO_LONG = "The email is too long: it can hold at most 5,000 characters of your own.";
const TOO_BIG = "The email is too long to save. Make it shorter.";
const NO_SUBJECT = "Write a subject.";
const LONG_SUBJECT = `The subject is too long: at most ${SUBJECT_MAX} characters.`;
const unknownField = (name: string) => `There's no field called {${name}} in this email. Pick one from Insert field.`;
const putBack = (label: string) => `Put the fixed part "${label}" back in the email. It can be moved, not removed.`;
const once = (label: string) => `The fixed part "${label}" is in the email twice. Leave it in once.`;

/** The same rule as a club message's links (src/lib/messages/body.ts): a full https, http or mailto address, or nothing. */
export function templateHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > LINK_MAX) return null;
  let url: URL;
  try { url = new URL(s); } catch { return null; }
  if (!["https:", "http:", "mailto:"].includes(url.protocol)) return null;
  return url.href.length <= LINK_MAX ? url.href : null;
}

class Refused extends Error {}
function refuse(why: string): never { throw new Refused(why); }
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Text a person typed: control characters but a tab are dropped (jsonb can't hold a NUL; a mail has no use for them).
// So are the marks that turn text around or hide in it (bidirectional controls, zero-width marks): in a mail they
// could make words read other than they are.
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "");
/** Half of a character that came apart (a lone surrogate): Postgres can't store it, so it is refused in words. */
const LONE_HALF = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const BROKEN = "The email has a character that can't be saved. Type that part again and try once more.";
/**
 * A web or email address written into the words: a mail program makes it a link, so a Sign-in email, whose one link is
 * the portal's, refuses one (the owner's answer 1: no links of the club's own there).
 */
const ADDRESS = /\b(?:https?:\/\/|www\.)|[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|io|us|co|info|app|biz|me|club|school|team|uk|ca)\b/i;
export const NO_ADDRESSES = "Sign-in emails can't hold web or email addresses of your own: the portal adds the one link they need. For the club's address, use the Club contact field.";

type State = { rules: TemplateRules; text: number; fixed: Map<string, number> };

function checkMarks(v: unknown, s: State): TemplateMark[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) refuse(OFF_LIST);
  const out: TemplateMark[] = [];
  for (const m of v as unknown[]) {
    if (!isObject(m)) refuse(OFF_LIST);
    const t = (m as Record<string, unknown>).type;
    if (t === "bold" || t === "italic" || t === "underline") out.push({ type: t });
    else if (t === "link") {
      if (!s.rules.links) refuse(NO_LINKS);
      const attrs = (m as Record<string, unknown>).attrs;
      const href = templateHref(isObject(attrs) ? attrs.href : null);
      if (!href) refuse(BAD_LINK);
      out.push({ type: "link", attrs: { href: href! } });
    } else refuse(OFF_LIST);
  }
  return out;
}

function checkInline(v: unknown, s: State): TemplateInline[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) refuse(OFF_LIST);
  const out: TemplateInline[] = [];
  for (const n of v as unknown[]) {
    if (!isObject(n)) refuse(OFF_LIST);
    if (n.type === "text") {
      if (typeof n.text !== "string") refuse(OFF_LIST);
      if (LONE_HALF.test(n.text as string)) refuse(BROKEN);
      const text = clean(n.text as string);
      if (!s.rules.links && ADDRESS.test(text)) refuse(NO_ADDRESSES);
      s.text += text.length;
      if (s.text > TEMPLATE_MAX_TEXT) refuse(TOO_LONG);
      const marks = checkMarks(n.marks, s);
      if (text) out.push(marks.length ? { type: "text", text, marks } : { type: "text", text });
    } else if (n.type === "hardBreak") out.push({ type: "hardBreak" });
    else if (n.type === "field") {
      const id = isObject(n.attrs) ? n.attrs.id : null;
      if (typeof id !== "string" || !s.rules.fields.some((f) => f.id === id)) refuse(unknownField(typeof id === "string" ? id.slice(0, 40) : "?"));
      out.push({ type: "field", attrs: { id: id as string } });
    } else refuse(OFF_LIST);
  }
  return out;
}

function checkList(n: Record<string, unknown>, s: State, depth: number): TemplateList {
  if (depth > MAX_DEPTH || !Array.isArray(n.content)) refuse(OFF_LIST);
  const items: TemplateListItem[] = [];
  for (const it of n.content as unknown[]) {
    if (!isObject(it) || it.type !== "listItem" || !Array.isArray(it.content)) refuse(OFF_LIST);
    const content: (TemplateParagraph | TemplateList)[] = [];
    for (const c of (it as Record<string, unknown>).content as unknown[]) {
      if (!isObject(c)) refuse(OFF_LIST);
      if (c.type === "paragraph") content.push(paragraph(c, s));
      else if (c.type === "bulletList" || c.type === "orderedList") content.push(checkList(c, s, depth + 1));
      else refuse(OFF_LIST);
    }
    items.push({ type: "listItem", content });
  }
  return { type: n.type as TemplateList["type"], content: items };
}

function paragraph(n: Record<string, unknown>, s: State): TemplateParagraph {
  const content = checkInline(n.content, s);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

/** The subject's fields, by the labels written in braces. */
const BRACES = /\{([^{}]*)\}/g;

export type TemplateCheck = { ok: true; subject: string | null; body: TemplateDoc } | { ok: false; errors: string[] };

/**
 * Rebuilds a template from what was sent, keeping only what the rules allow: paragraphs, bulleted and numbered lists,
 * bold, italic, underline, links where the email may hold them, hard breaks, the email's own fields, and each of its
 * fixed parts exactly once. The subject is one line with fields written by their labels in braces, or null for an
 * email whose subject is the portal's own. Anything else is refused, in a sentence.
 */
export function checkTemplate(rules: TemplateRules, input: { subject: unknown; body: unknown }): TemplateCheck {
  const errors: string[] = [];
  let subject: string | null = null;
  if (!rules.subjectFixed) {
    if (typeof input.subject !== "string") errors.push(NO_SUBJECT);
    else if (LONE_HALF.test(input.subject)) errors.push(BROKEN);
    else {
      subject = clean(input.subject).replace(/\s+/g, " ").trim();
      if (!subject) errors.push(NO_SUBJECT);
      else if (!rules.links && ADDRESS.test(subject)) errors.push(NO_ADDRESSES);
      else if (subject.length > SUBJECT_MAX) errors.push(LONG_SUBJECT);
      else for (const [, raw] of subject.matchAll(BRACES)) {
        const name = raw ?? "";
        if (!rules.fields.some((f) => f.label === name.trim())) { errors.push(unknownField(name.trim().slice(0, 40))); break; }
      }
    }
  }
  let body: TemplateDoc | null = null;
  try {
    if (JSON.stringify(input.body ?? null).length > TEMPLATE_MAX_BYTES) refuse(TOO_BIG);
    const doc = input.body;
    if (!isObject(doc) || doc.type !== "doc" || !Array.isArray(doc.content)) refuse(OFF_LIST);
    const s: State = { rules, text: 0, fixed: new Map() };
    const content: TemplateBlock[] = [];
    for (const n of (doc as Record<string, unknown>).content as unknown[]) {
      if (!isObject(n)) refuse(OFF_LIST);
      if (n.type === "paragraph") content.push(paragraph(n, s));
      else if (n.type === "bulletList" || n.type === "orderedList") content.push(checkList(n, s, 1));
      else if (n.type === "fixedPart") {
        const id = isObject(n.attrs) ? n.attrs.id : null;
        if (typeof id !== "string" || !rules.fixed.some((f) => f.id === id)) refuse(OFF_LIST);
        s.fixed.set(id as string, (s.fixed.get(id as string) ?? 0) + 1);
        content.push({ type: "fixedPart", attrs: { id: id as string } });
      } else refuse(OFF_LIST);
    }
    for (const f of rules.fixed) {
      const count = s.fixed.get(f.id) ?? 0;
      if (count === 0) errors.push(putBack(f.label));
      else if (count > 1) errors.push(once(f.label));
    }
    body = { type: "doc", content };
  } catch (e) {
    if (e instanceof Refused) errors.push(e.message); else throw e;
  }
  return errors.length || !body ? { ok: false, errors } : { ok: true, subject, body };
}

/** The subject with each field's value in place of its label in braces; a field with no value leaves nothing. */
export function renderSubject(subject: string, fields: readonly { id: string; label: string }[], values: Record<string, string | null>): string {
  return subject.replace(BRACES, (whole, name: string) => {
    const f = fields.find((x) => x.label === name.trim());
    return f ? (values[f.id] ?? "") : whole;
  });
}

type Drawn = { text: string; html: string; missing: boolean };

function inlineOf(nodes: TemplateInline[] | undefined, values: Record<string, string | null>): Drawn {
  let text = "", html = "", missing = false;
  for (const n of nodes ?? []) {
    if (n.type === "hardBreak") { text += "\n"; html += "<br>"; continue; }
    if (n.type === "field") {
      const v = values[n.attrs.id];
      if (v === null || v === undefined) { missing = true; continue; }
      text += v; html += esc(v);
      continue;
    }
    const link = n.marks?.find((m): m is Extract<TemplateMark, { type: "link" }> => m.type === "link");
    let h = esc(n.text);
    if (n.marks?.some((m) => m.type === "underline")) h = `<u>${h}</u>`;
    if (n.marks?.some((m) => m.type === "italic")) h = `<em>${h}</em>`;
    if (n.marks?.some((m) => m.type === "bold")) h = `<strong>${h}</strong>`;
    if (link) h = `<a href="${esc(link.attrs.href)}">${h}</a>`;
    text += link && link.attrs.href !== n.text ? `${n.text} (${link.attrs.href})` : n.text;
    html += h;
  }
  return { text, html, missing };
}

function listOf(l: TemplateList, values: Record<string, string | null>, indent: string): { text: string[]; html: string } {
  const text: string[] = [];
  let html = "";
  l.content.forEach((item, i) => {
    const mark = l.type === "orderedList" ? `${i + 1}.` : "-";
    let first = true, inner = "";
    for (const c of item.content) {
      if (c.type === "paragraph") {
        const d = inlineOf(c.content, values);
        if (d.missing || !d.text.trim()) continue;
        text.push(`${indent}${first ? `${mark} ` : "  "}${d.text}`);
        inner += first ? d.html : `<br>${d.html}`;
        first = false;
      } else {
        const sub = listOf(c, values, `${indent}  `);
        text.push(...sub.text);
        inner += sub.html;
      }
    }
    if (inner) html += `<li>${inner}</li>`;
  });
  const tag = l.type === "orderedList" ? "ol" : "ul";
  return { text, html: html ? `<${tag} style="margin:0 0 16px">${html}</${tag}>` : "" };
}

/**
 * A template's body as a mail's blocks: each paragraph its own (left out when it is empty, or when a field in it has no
 * value for this send, as "Questions? Write to {Club contact}." is for a club with no contact), each list one block,
 * and each fixed part the blocks the portal draws for it (`fixed`), which may be none.
 */
export function renderBody(doc: TemplateDoc, values: Record<string, string | null>, fixed: (id: string) => Block[]): Block[] {
  const out: Block[] = [];
  for (const b of doc.content) {
    if (b.type === "fixedPart") { out.push(...fixed(b.attrs.id)); continue; }
    if (b.type === "paragraph") {
      const d = inlineOf(b.content, values);
      if (d.missing || !d.text.trim()) continue;
      out.push({ text: d.text, html: `${PARAGRAPH}${d.html}</p>` });
      continue;
    }
    const l = listOf(b, values, "");
    if (l.text.length) out.push({ text: l.text.join("\n"), html: l.html });
  }
  return out;
}

/* ---- Writing a default: what the catalog's defaults are made of. ---- */

/** A paragraph of text and fields: `{ field: "clubName" }` for a field. */
export const para = (...parts: (string | { field: string })[]): TemplateParagraph => {
  const content = parts.filter((p) => p !== "").map((p): TemplateInline => (typeof p === "string" ? { type: "text", text: p } : { type: "field", attrs: { id: p.field } }));
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
};
export const fixedPart = (id: string): TemplateBlock => ({ type: "fixedPart", attrs: { id } });
export const field = (id: string) => ({ field: id });
export const doc = (...content: TemplateBlock[]): TemplateDoc => ({ type: "doc", content });
