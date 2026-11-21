import { Fragment, type ReactNode } from "react";

export type KeyValueItem = { key: string; label: ReactNode; value: ReactNode; numeric?: boolean };

/** A details list (`dl.details`): quiet labels beside their values ("Name", "Email", "Phone"). Leave out an item with no value. */
export function KeyValue({ items }: { items: (KeyValueItem | false | null | undefined)[] }) {
  return (
    <dl className="details">
      {items.filter((i): i is KeyValueItem => Boolean(i)).map((i) => (
        <Fragment key={i.key}><dt>{i.label}</dt><dd className={i.numeric ? "num" : undefined}>{i.value}</dd></Fragment>
      ))}
    </dl>
  );
}
