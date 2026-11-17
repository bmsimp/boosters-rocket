import type { ReactNode } from "react";

/**
 * The table primitive (DESIGN.md, Tables): a real table at laptop widths, with a caption and header cells that have a
 * scope, and on a phone each row stacked as a small ruled block, every cell under the label of its column. The
 * stacking is CSS only, and CSS that changes how a table displays can take its table semantics away in some browsers,
 * so every element carries its role (table, rowgroup, row, columnheader, rowheader, cell) and a screen reader still
 * reads a table. The label in each cell is a copy of its column's header for sighted readers on a phone: hidden from
 * assistive technology, which has the header already. No sorting control: a column the rows are listed in the order
 * of says so with `sorted`. Cells are React nodes, so QuickBooks text stays text.
 */
export type Column<R> = {
  key: string;
  /** The header cell's words, and the label a cell carries when the rows stack on a phone. */
  header: string;
  cell: (row: R) => ReactNode;
  /** Numbers and amounts: right-aligned, in tabular figures. */
  numeric?: boolean;
  /** The cell that names the row: a header cell with scope="row", drawn first and bold when rows stack. */
  rowHeader?: boolean;
  /** A column of buttons, whose header is for screen readers only and whose cells carry no label on a phone. */
  quiet?: boolean;
  /** The rows are listed in this column's order (no control is drawn: the page decides the order). */
  sorted?: "ascending" | "descending";
};

/** A heading row and the rows under it, such as a family and its students. */
export type RowGroup<R> = { key: string; heading: ReactNode; rows: R[] };

type Props<R> = {
  caption: ReactNode;
  /** The caption is still read out, but not drawn: the box's own heading already says it. */
  captionHidden?: boolean;
  columns: Column<R>[];
  rowKey: (row: R) => string;
  className?: string;
} & ({ rows: R[]; groups?: never } | { groups: RowGroup<R>[]; rows?: never });

function Row<R>({ row, columns }: { row: R; columns: Column<R>[] }) {
  return (
    <tr role="row">
      {columns.map((c) => {
        const className = [c.numeric ? "t-num" : "", c.quiet ? "t-quiet" : ""].filter(Boolean).join(" ") || undefined;
        const label = c.rowHeader || c.quiet ? null : <span className="t-label" aria-hidden="true">{c.header}</span>;
        return c.rowHeader
          ? <th key={c.key} role="rowheader" scope="row" className={className}>{c.cell(row)}</th>
          : <td key={c.key} role="cell" className={className}>{label}<div className="t-value">{c.cell(row)}</div></td>;
      })}
    </tr>
  );
}

export function DataTable<R>({ caption, captionHidden = false, columns, rowKey, className, rows, groups }: Props<R>) {
  return (
    <table role="table" className={["table", className].filter(Boolean).join(" ")}>
      <caption className={captionHidden ? "visually-hidden" : undefined}>{caption}</caption>
      <thead role="rowgroup">
        <tr role="row">{columns.map((c) => (
          <th key={c.key} role="columnheader" scope="col" aria-sort={c.sorted} className={c.numeric ? "t-num" : undefined}>
            {c.quiet ? <span className="visually-hidden">{c.header}</span> : c.header}
          </th>))}</tr>
      </thead>
      {groups ? groups.map((g) => (
        <tbody role="rowgroup" key={g.key}>
          <tr role="row" className="t-group"><th role="rowheader" scope="rowgroup" colSpan={columns.length}>{g.heading}</th></tr>
          {g.rows.map((r) => <Row key={rowKey(r)} row={r} columns={columns} />)}
        </tbody>
      )) : (
        <tbody role="rowgroup">{rows.map((r) => <Row key={rowKey(r)} row={r} columns={columns} />)}</tbody>
      )}
    </table>
  );
}
