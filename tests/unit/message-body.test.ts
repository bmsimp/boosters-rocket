import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BODY_MAX_TEXT, checkBody, EMPTY_BODY, isEmptyBody, renderBody, storedBody, type MessageBody } from "@/lib/messages/body";

/** A club message's body is checked against an allowlist and drawn by our own code (spec sections 6 and 13). */
const PIC = "8b7c2a4e-1f3d-4c5b-9a6e-0d1c2b3a4f5e", OTHER = "11111111-2222-4333-8444-555555555555";
const pictures = new Set([PIC]);
const doc = (...content: unknown[]) => ({ type: "doc", content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, marks?: unknown[]) => (marks ? { type: "text", text, marks } : { type: "text", text });
const link = (href: string, extra: Record<string, unknown> = {}) => ({ type: "link", attrs: { href, ...extra } });
const refused = (input: unknown, set: ReadonlySet<string> = pictures) => expect(checkBody(input, set).ok, JSON.stringify(input).slice(0, 200)).toBe(false);
const kept = (input: unknown, set: ReadonlySet<string> = pictures) => {
  const r = checkBody(input, set);
  if (!r.ok) throw new Error(r.error);
  return r;
};
const draw = (b: MessageBody) => renderToStaticMarkup(renderBody(b, { fileHref: (id) => `/staff/messages/files/${id}` }));

describe("checkBody()", () => {
  it("keeps everything the editor offers, as it is", () => {
    const body = doc(
      { type: "heading", attrs: { level: 2 }, content: [t("Practice")] },
      { type: "heading", attrs: { level: 3 }, content: [t("Times")] },
      p(t("Bring "), t("water", [{ type: "bold" }]), t(", ", [{ type: "italic" }]), t("snacks", [{ type: "underline" }]), { type: "hardBreak" }, t("and "),
        t("the form", [link("https://club.org/form")])),
      { type: "bulletList", content: [{ type: "listItem", content: [p(t("one"))] }, { type: "listItem", content: [p(t("two")), { type: "orderedList", content: [{ type: "listItem", content: [p(t("a"))] }] }] }] },
      { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p(t("three"))] }] },
      { type: "image", attrs: { attachment: PIC, alt: "The team" } },
      p(t("write", [link("mailto:coach@club.org")])),
    );
    const r = kept(body);
    expect(r.body).toEqual(body);
    expect(r.pictures).toEqual([PIC]);
  });

  it("drops what the editor writes by default and the address carries no meaning in (a link's target, rel and class; a null attribute)", () => {
    const r = kept(doc(
      p(t("x", [link("https://club.org", { target: "_blank", rel: "noopener noreferrer nofollow", class: null })])),
      { type: "orderedList", attrs: { start: 1, type: null }, content: [{ type: "listItem", content: [p(t("y"))] }] },
    ));
    expect(r.body.content[0]).toEqual(p(t("x", [link("https://club.org/")])));
    expect(r.body.content[1]).toEqual({ type: "orderedList", content: [{ type: "listItem", content: [p(t("y"))] }] });
  });

  it.each([
    ["a table", { type: "table", content: [] }],
    ["a code block", { type: "codeBlock", content: [t("x")] }],
    ["a quote", { type: "blockquote", content: [p(t("x"))] }],
    ["a rule", { type: "horizontalRule" }],
    ["an embed", { type: "iframe", attrs: { src: "https://evil.example" } }],
    ["raw HTML", { type: "html", text: "<script>alert(1)</script>" }],
    ["a heading at level 1", { type: "heading", attrs: { level: 1 }, content: [t("x")] }],
    ["a heading at level 4", { type: "heading", attrs: { level: 4 }, content: [t("x")] }],
    ["a paragraph aligned", { type: "paragraph", attrs: { textAlign: "center" }, content: [t("x")] }],
    ["a paragraph with a style", { type: "paragraph", attrs: { style: "color:red" }, content: [t("x")] }],
    ["a node with a key of its own", { type: "paragraph", content: [t("x")], html: "<b>x</b>" }],
    ["text with a color", p(t("x", [{ type: "textStyle", attrs: { color: "red" } }]))],
    ["text with a font", p(t("x", [{ type: "textStyle", attrs: { fontFamily: "Comic Sans" } }]))],
    ["code", p(t("x", [{ type: "code" }]))],
    ["strike-through", p(t("x", [{ type: "strike" }]))],
    ["highlight", p(t("x", [{ type: "highlight" }]))],
    ["bold with an attribute", p(t("x", [{ type: "bold", attrs: { class: "big" } }]))],
    ["a text node that isn't text", p({ type: "text", text: 5 })],
    ["a list with no items", { type: "bulletList", content: [] }],
    ["a list holding a paragraph", { type: "bulletList", content: [p(t("x"))] }],
    ["a text node in the document's root", t("x")],
  ])("refuses %s", (_, node) => refused(doc(node)));

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["JavaScript: written oddly", " JaVaScRiPt:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["a relative address", "/staff/settings"],
    ["a protocol-relative address", "//evil.example"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["ftp:", "ftp://club.org/file"],
    ["an address over 2,000 characters", `https://club.org/${"a".repeat(2000)}`],
    ["no address at all", undefined],
  ])("refuses a %s link", (_, href) => refused(doc(p(t("x", [{ type: "link", attrs: { href } }])))));

  it("refuses a picture given by an address, another message's file, or with attributes of its own", () => {
    refused(doc({ type: "image", attrs: { src: "https://evil.example/x.png" } }));
    refused(doc({ type: "image", attrs: { attachment: PIC, src: "https://evil.example/x.png" } }));
    refused(doc({ type: "image", attrs: { attachment: OTHER } }));
    refused(doc({ type: "image", attrs: { attachment: PIC, onerror: "alert(1)" } }));
    refused(doc({ type: "image", attrs: { attachment: PIC } }), new Set());
  });

  it("cuts a picture's words to 300 characters", () => {
    const r = kept(doc({ type: "image", attrs: { attachment: PIC, alt: "a".repeat(400) } }));
    expect(r.body.content[0]).toEqual({ type: "image", attrs: { attachment: PIC, alt: "a".repeat(300) } });
  });

  it("refuses a body over 20,000 characters of text or 100 KB of JSON, and takes one at the limit", () => {
    expect(kept(doc(p(t("a".repeat(BODY_MAX_TEXT))))).textLength).toBe(BODY_MAX_TEXT);
    refused(doc(p(t("a".repeat(BODY_MAX_TEXT + 1)))));
    // 3,000 characters of text in over 100 KB of JSON.
    const big = doc(...Array.from({ length: 3000 }, () => p(t("a", [{ type: "bold" }, { type: "italic" }]))));
    expect(JSON.stringify(big).length).toBeGreaterThan(100 * 1024);
    expect(checkBody(big, pictures)).toEqual({ ok: false, error: "The message is too long to save. Make it shorter." });
    expect(checkBody(doc(p(t("a".repeat(BODY_MAX_TEXT + 1)))), pictures)).toEqual({ ok: false, error: "The message is too long: it can hold at most 20,000 characters." });
  });

  it("refuses what isn't a document, and lists nested too deep", () => {
    for (const bad of [null, "text", [], { type: "paragraph" }, { type: "doc", content: "x" }, { type: "doc" }]) refused(bad);
    let list: unknown = p(t("deep"));
    for (let i = 0; i < 20; i++) list = { type: "bulletList", content: [{ type: "listItem", content: [list] }] };
    refused(doc(list));
  });

  it("drops control characters and empty text, and gives an empty body the editor's empty paragraph", () => {
    expect(kept(doc(p(t("a\u0000b\u0007c"), t(""))))).toMatchObject({ body: doc(p(t("abc"))) });
    expect(kept(doc()).body).toEqual(EMPTY_BODY);
    expect(isEmptyBody(kept(doc(p(t("  ")))).body)).toBe(true);
    expect(isEmptyBody(kept(doc({ type: "image", attrs: { attachment: PIC } })).body)).toBe(false);
  });

  it("checks a stored body again on the way out, drawing nothing of one that no longer passes", () => {
    expect(storedBody(doc(p(t("fine"))), [])).toEqual(doc(p(t("fine"))));
    expect(storedBody(doc({ type: "html", text: "<script>" }), [])).toEqual(EMPTY_BODY);
    expect(storedBody(doc({ type: "image", attrs: { attachment: PIC } }), [])).toEqual(EMPTY_BODY);
  });
});

describe("renderBody()", () => {
  it("draws a stored <script> as text, never as HTML", () => {
    const html = draw(kept(doc(p(t("<script>alert(1)</script>")), p(t("<img src=x onerror=alert(1)>")))).body);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("draws the marks, lists and headings, the headings one level under the message's title", () => {
    const html = draw(kept(doc(
      { type: "heading", attrs: { level: 2 }, content: [t("Big")] },
      { type: "heading", attrs: { level: 3 }, content: [t("Small")] },
      p(t("b", [{ type: "bold" }]), t("i", [{ type: "italic" }]), t("u", [{ type: "underline" }]), { type: "hardBreak" }),
      { type: "orderedList", attrs: { start: 4 }, content: [{ type: "listItem", content: [p(t("four"))] }] },
    )).body);
    expect(html).toContain("<h3>Big</h3><h4>Small</h4>");
    expect(html).toContain("<strong>b</strong><em>i</em><u>u</u><br/>");
    expect(html).toContain('<ol start="4"><li><p>four</p></li></ol>');
  });

  it("draws a picture from the file route by its id, with its words", () => {
    const html = draw(kept(doc({ type: "image", attrs: { attachment: PIC, alt: "Team \"photo\"" } })).body);
    expect(html).toContain(`src="/staff/messages/files/${PIC}"`);
    expect(html).toContain('alt="Team &quot;photo&quot;"');
  });

  it("opens a link with rel=noopener noreferrer, and shows its address when its words differ", () => {
    const html = draw(kept(doc(
      p(t("the "), t("schedule", [link("https://club.org/schedule"), { type: "bold" }]), t(" page", [link("https://club.org/schedule")])),
      p(t("https://club.org/", [link("https://club.org/")])),
      p(t("coach@club.org", [link("mailto:coach@club.org")])),
    )).body);
    expect(html).toContain('<a href="https://club.org/schedule" rel="noopener noreferrer"><strong>schedule</strong> page</a><span class="msg-link-address"> (https://club.org/schedule)</span>');
    expect(html).toContain('<a href="https://club.org/" rel="noopener noreferrer">https://club.org/</a></p>');
    expect(html).toContain('<a href="mailto:coach@club.org" rel="noopener noreferrer">coach@club.org</a></p>');
  });
});
