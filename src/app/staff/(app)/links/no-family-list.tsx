"use client";
import { useTransition } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { Button, LinkButton } from "@/app/components/ui/button";
import { BulkSelect } from "@/app/components/ui/bulk-select";
import type { BulkAnswer } from "@/app/components/ui/bulk-action";
import { CreateFamiliesBulk } from "./bulk-presses";
import { useLinkAnswer } from "./link-press";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };

/**
 * One row as the server words it: its key (the customer's id, which the bound press carries to the browser anyway, so
 * a row keeps its own pending press when the list shrinks), the customer's name (QuickBooks text, shown as text), its
 * students, what pressing makes, and the press bound to it; or, for a customer meant for a family the portal has
 * (stage 4's slice M3a2), no press but `aim`: words naming that family and the address on Accounting links where the
 * two are linked (an app uuid and the customer's digits, no books text), with the link's words.
 */
export type NoFamilyRow = { key: string; name: string; students: string; makes: string; act: (() => Promise<Done>) | null; aim: { words: string; href: string; label: string } | null };

/** A refusal said with the customer it is about (a family made names itself), so answers to several presses are told apart. */
const about = (name: string, r: Done): Done => (r.ok ? r : { ok: false, errors: r.errors.map((e) => `${name}: ${e}`) });

/**
 * The list of customers with no family. Each press's answer is kept with every other press's on the page, above
 * everything (LinkAnswers, ./link-press.tsx), not in the rows: a family made takes its customer off the list when the
 * page is read again, and the part folds to one line when it was the last, and its answer stays. Each press keeps its
 * own, so two pressed one after the other both stay.
 */
export function NoFamilyRows({ rows, none, bulk }: { rows: NoFamilyRow[]; none: string; bulk: (ids: string[]) => Promise<BulkAnswer> }) {
  const add = useLinkAnswer();
  const onDone = (name: string, r: Done) => add(about(name, r));
  // Create families (src/lib/bulk.ts): a box on each row "Create a family from this" is offered on, none on a customer
  // meant for a family the portal has; each row ticked is made by that press's own function, in its own transaction.
  const picks = rows.filter((r) => r.act !== null).map((r) => ({ id: r.key, name: r.name, makes: r.makes }));
  const table = (
    <DataTable caption="With no family" captionHidden rowKey={(r) => r.key} rows={rows}
      select={picks.length > 0 ? { label: (r) => r.name, when: (r) => r.act !== null } : undefined}
      columns={[
        { key: "name", header: "In your books", rowHeader: true, cell: (r) => <>{r.name}<span className="when">Students under it: {r.students}</span></> },
        { key: "makes", header: "What it makes", cell: (r) => (r.aim !== null ? r.aim.words : r.makes) },
        { key: "do", header: "Actions", quiet: true, cell: (r) => (r.aim !== null || r.act === null
          ? r.aim && <div className="row-actions"><LinkButton variant="tonal" size="sm" href={r.aim.href}>{r.aim.label}<span className="visually-hidden">: {r.name}</span></LinkButton></div>
          : <MakeFamily name={r.name} act={r.act} onDone={(d) => onDone(r.name, d)} />) },
      ]} />
  );
  if (rows.length === 0) return <Notice tone="done" live="none">{none}</Notice>;
  if (picks.length === 0) return table;
  return (
    <BulkSelect pageIds={picks.map((p) => p.id)} noun={{ one: "customer", many: "customers" }} actions={<CreateFamiliesBulk rows={picks} act={bulk} />}>
      {table}
    </BulkSelect>
  );
}

function MakeFamily({ name, act, onDone }: { name: string; act: () => Promise<Done>; onDone: (r: Done) => void }) {
  const [pending, start] = useTransition();
  const press = () => { if (!pending) start(async () => onDone(await safely(() => act(), failed))); };
  return (
    <div className="row-actions">
      <Button variant="tonal" size="sm" busy={pending} onClick={press}>
        {pending ? "Making the family…" : "Create a family"}<span className="visually-hidden">: {name}</span>
      </Button>
    </div>
  );
}
