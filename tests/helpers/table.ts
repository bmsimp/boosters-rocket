/**
 * Reading the table primitive (src/app/components/data-table.tsx) out of rendered markup. The rows are found by a name
 * in one of their cells; a cell's words are its text, without the label a phone shows above it. A bulk select's box
 * (`select`, the cell `t-check`) is no cell of words, so it is left out.
 */

const textOf = (cell: string) => cell.replace(/<span class="t-label"[^>]*>[\s\S]*?<\/span>/, "").replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** Every body row of every table in the markup, as the words of its cells. Group heading rows are left out. */
export function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr role="row"(?: class="([^"]*)")?>([\s\S]*?)<\/tr>/g)]
    .filter((m) => !(m[1] ?? "").includes("t-group") && !m[2]!.includes('role="columnheader"'))
    .map((m) => [...m[2]!.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/g)].filter((c) => !c[2]!.includes('class="t-check"')).map((c) => textOf(c[3]!)));
}

/** The row whose cells include `name` exactly, or undefined. */
export const rowNamed = (html: string, name: string): string[] | undefined => tableRows(html).find((r) => r.includes(name));

/** The header cells of every table, in order, as their words. */
export const tableHeaders = (html: string): string[] =>
  [...html.matchAll(/<th role="columnheader"([^>]*)>([\s\S]*?)<\/th>/g)].filter((m) => !m[1]!.includes('class="t-check"')).map((m) => m[2]!.replace(/<[^>]+>/g, ""));
