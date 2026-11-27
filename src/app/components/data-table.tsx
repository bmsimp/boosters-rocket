import { Fragment, type ReactNode } from "react";
import { HeaderCheck, RowCheck } from "./ui/bulk-select";

/**
 * The table primitive (docs/agents/ui.md): a real table at laptop widths, with a caption and header cells that have a
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
  /**
   * Bulk select (inside BulkSelect, src/app/components/ui/bulk-select.tsx): a tick box first in every row, labelled
   * "Select" and these words (the row's name), and one in the header. The row's id is its rowKey. `when`: only the rows
   * a bulk action can take get a box (the rest an empty cell); BulkSelect's `pageIds` are then those rows alone.
   */
  select?: { label: (row: R) => string; when?: (row: R) => boolean };
  /**
   * A row's expansion (the owner's one exception to "no fold-outs", 2026-11-27: two records compared side by side): a
   * second row under each, its one cell the table's full width, holding what a button in the row shows and hides
   * (`aria-expanded`, `aria-controls`). The row is drawn only while what it holds isn't `hidden`.
   */
  expand?: (row: R) => ReactNode;
} & ({ rows: R[]; groups?: never } | { groups: RowGroup<R>[]; rows?: never });

function Row<R>({ row, columns, check }: { row: R; columns: Column<R>[]; check?: ReactNode }) {
  return (
    <tr role="row">
      {check && <td role="cell" className="t-check">{check}</td>}
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

export function DataTable<R>({ caption, captionHidden = false, columns, rowKey, className, rows, groups, select, expand }: Props<R>) {
  const check = (r: R) => (!select ? undefined : select.when && !select.when(r) ? <span /> : <RowCheck id={rowKey(r)} label={`Select ${select.label(r)}`} />);
  const span = columns.length + (select ? 1 : 0);
  const one = (r: R) => (expand === undefined ? <Row key={rowKey(r)} row={r} columns={columns} check={check(r)} />
    : <Fragment key={rowKey(r)}><Row row={r} columns={columns} check={check(r)} /><tr role="row" className="t-more"><td role="cell" colSpan={span}>{expand(r)}</td></tr></Fragment>);
  return (
    <table role="table" className={["table", className].filter(Boolean).join(" ")}>
      <caption className={captionHidden ? "visually-hidden" : undefined}>{caption}</caption>
      <thead role="rowgroup">
        <tr role="row">{select && <th role="columnheader" scope="col" className="t-check"><HeaderCheck /></th>}{columns.map((c) => (
          <th key={c.key} role="columnheader" scope="col" aria-sort={c.sorted} className={c.numeric ? "t-num" : undefined}>
            {c.quiet ? <span className="visually-hidden">{c.header}</span> : c.header}
          </th>))}</tr>
      </thead>
      {groups ? groups.map((g) => (
        <tbody role="rowgroup" key={g.key}>
          <tr role="row" className="t-group"><th role="rowheader" scope="rowgroup" colSpan={span}>{g.heading}</th></tr>
          {g.rows.map(one)}
        </tbody>
      )) : (
        <tbody role="rowgroup">{rows.map(one)}</tbody>
      )}
    </table>
  );
}
