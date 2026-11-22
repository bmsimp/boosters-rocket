import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable, type Column } from "@/app/components/data-table";
import { ActionOutcome, Notice, NOTICE_STATUS_TONE, TONE_WORDS } from "@/app/components/notice";
import { tableHeaders, tableRows } from "../helpers/table";

type Row = { id: string; name: string; owed: string };
const COLUMNS: Column<Row>[] = [
  { key: "name", header: "Family", rowHeader: true, sorted: "ascending", cell: (r) => r.name },
  { key: "owed", header: "Owed", numeric: true, cell: (r) => r.owed },
  { key: "do", header: "What you can do", quiet: true, cell: (r) => h("button", { type: "button" }, `Remind ${r.name}`) },
];
const ROWS: Row[] = [{ id: "1", name: "Rivera <b>Family</b>", owed: "$85.00" }, { id: "2", name: "Chen Family", owed: "$0.00" }];
const table = (props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) =>
  renderToStaticMarkup(h(DataTable<Row>, { caption: "Families, by name", columns: COLUMNS, rows: ROWS, rowKey: (r) => r.id, ...props } as Parameters<typeof DataTable<Row>>[0]));

describe("the table primitive", () => {
  it("is a table with a caption, header cells with a scope, and every role set, so a stacked row still reads as a table", () => {
    const html = table();
    expect(html).toMatch(/^<table role="table" class="table"><caption>Families, by name<\/caption>/);
    expect(html).toContain('<thead role="rowgroup"><tr role="row">');
    expect(html.match(/<th role="columnheader" scope="col"/g)).toHaveLength(3);
    expect(html).toContain('<th role="columnheader" scope="col" aria-sort="ascending">Family</th>');
    expect(html.match(/<th role="rowheader" scope="row">/g)).toHaveLength(2);
    expect(html.match(/<td role="cell"/g)).toHaveLength(4);
    expect(html).toContain('<tbody role="rowgroup">');
    expect(html).not.toMatch(/<(tr|td|th|thead|tbody)(?![^>]*role=)/); // no part of the table without its role
  });

  it("aligns numbers, labels each cell for a phone without reading the label twice, and hides only a buttons column's header", () => {
    const html = table();
    expect(html).toContain('<th role="columnheader" scope="col" class="t-num">Owed</th>');
    expect(html).toContain('<td role="cell" class="t-num"><span class="t-label" aria-hidden="true">Owed</span><div class="t-value">$85.00</div></td>');
    expect(html).toContain('<th role="columnheader" scope="col"><span class="visually-hidden">What you can do</span></th>');
    expect(html).toContain('<td role="cell" class="t-quiet"><div class="t-value"><button type="button">'); // no label above buttons
    expect(tableHeaders(html)).toEqual(["Family", "Owed", "What you can do"]);
    expect(tableRows(html)).toEqual([["Rivera <b>Family</b>", "$85.00", "Remind Rivera <b>Family</b>"], ["Chen Family", "$0.00", "Remind Chen Family"]]);
  });

  it("writes text as text", () => {
    const html = table();
    expect(html).toContain("Rivera &lt;b&gt;Family&lt;/b&gt;");
    expect(html).not.toContain("<b>Family</b>");
  });

  it("can hide its caption from sight but not from a screen reader, and groups rows under a heading row", () => {
    const html = table({ captionHidden: true, rows: undefined, groups: [{ key: "g1", heading: "Rivera Family", rows: [ROWS[0]!] }, { key: "g2", heading: "Chen Family", rows: [ROWS[1]!] }] });
    expect(html).toContain('<caption class="visually-hidden">Families, by name</caption>');
    expect(html.match(/<tbody role="rowgroup">/g)).toHaveLength(2);
    expect(html).toContain('<tr role="row" class="t-group"><th role="rowheader" scope="rowgroup" colSpan="3">Rivera Family</th></tr>');
    expect(tableRows(html)).toHaveLength(2); // the heading rows aren't body rows
  });
});

describe("the notice primitive", () => {
  it("says its tone in a word beside its icon, and is announced as a status, or as an alert for a problem", () => {
    for (const tone of ["info", "warning", "done", "problem"] as const) {
      const html = renderToStaticMarkup(h(Notice, { tone }, "Saved."));
      expect(html).toContain(`class="notice notice-${NOTICE_STATUS_TONE[tone]}" role="${tone === "problem" ? "alert" : "status"}"`);
      expect(html).toContain(`<span class="notice-word">${TONE_WORDS[tone]}</span> Saved.`);
      expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    }
    expect(new Set(Object.values(TONE_WORDS)).size).toBe(4); // each tone its own word: never color alone
    expect(renderToStaticMarkup(h(Notice, { tone: "warning", live: "none" }, "x"))).not.toContain("role=");
  });

  it("with a title is a section named by its heading, the word read before it", () => {
    const html = renderToStaticMarkup(h(Notice, { tone: "warning", title: "QuickBooks needs attention", titleId: "q-h" }, "Reconnect it."));
    expect(html).toContain('<section class="notice notice-due" role="status" aria-labelledby="q-h">');
    expect(html).toContain('<h2 id="q-h" class="notice-title"><span class="visually-hidden">Needs attention: </span>QuickBooks needs attention</h2>');
  });

  it("tells what a server action answered: done with its message, a problem with each sentence", () => {
    expect(renderToStaticMarkup(h(ActionOutcome, { state: null }))).toBe("");
    expect(renderToStaticMarkup(h(ActionOutcome, { state: { ok: true, message: "Saved." } }))).toContain('role="status"');
    const one = renderToStaticMarkup(h(ActionOutcome, { state: { ok: false, errors: ["Say why."] } }));
    expect(one).toContain('role="alert"');
    expect(one).toContain("</span> Say why.</div>");
    const two = renderToStaticMarkup(h(ActionOutcome, { state: { ok: false, errors: ["One.", "Two."] } }));
    expect(two).toContain('<ul class="notice-list"><li>One.</li><li>Two.</li></ul>');
  });

  it("says Done only for an answer with no status: a change saved first that is waiting is information, one held back or refused needs attention", () => {
    const word = (status?: "waiting" | "attention") => renderToStaticMarkup(h(ActionOutcome, { state: { ok: true, message: "Saved.", ...(status ? { status } : {}) } }));
    expect(word()).toContain(`<span class="notice-word">${TONE_WORDS.done}</span> Saved.`);
    expect(word("waiting")).toContain(`<span class="notice-word">${TONE_WORDS.info}</span> Saved.`);
    expect(word("attention")).toContain(`<span class="notice-word">${TONE_WORDS.warning}</span> Saved.`);
    expect(word("attention")).not.toContain(TONE_WORDS.done);
  });
});
