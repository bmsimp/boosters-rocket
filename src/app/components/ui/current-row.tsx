"use client";
import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";

/**
 * A table row that is the current one while a Drawer about it is open (DataTable's `current`): the address's `param`
 * is `value` for one of `params`. It then carries `aria-current="true"` and is drawn as a ticked row is, in the
 * secondary container, so the person sees which row the open Drawer (docked beside the table, or modal over it) is
 * about. It reads the address in the browser, so a Drawer opened without a load marks its row at once.
 */
export function CurrentRow({ params, value, children }: { params: readonly string[]; value: string; children: ReactNode }) {
  const search = useSearchParams();
  const current = params.some((p) => search?.get(p) === value);
  return <tr role="row" aria-current={current ? "true" : undefined}>{children}</tr>;
}
