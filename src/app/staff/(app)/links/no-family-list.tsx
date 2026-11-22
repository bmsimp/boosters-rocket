"use client";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { DataTable } from "@/app/components/data-table";
import { ActionOutcome, Notice } from "@/app/components/notice";
import { Button } from "@/app/components/ui/button";

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
 * The list of customers with no family and an answer for each press, the newest first. The answers are kept here,
 * above the table, not in the rows: a family made takes its customer off the list when the page is read again, and its
 * answer stays. Each press keeps its own, so two pressed one after the other both stay.
 */
export function NoFamilyRows({ rows, none }: { rows: NoFamilyRow[]; none: string }) {
  const [outcomes, setOutcomes] = useState<{ n: number; state: Done }[]>([]);
  const pressed = useRef(0);
  const onDone = (name: string, r: Done) => { const n = ++pressed.current; setOutcomes((had) => [{ n, state: about(name, r) }, ...had]); };
  return (
    <>
      {outcomes.map((o) => <ActionOutcome key={o.n} state={o.state} />)}
      {rows.length === 0 ? <Notice tone="done" live="none">{none}</Notice> : (
        <DataTable caption="Customers with no family" captionHidden rowKey={(r) => r.key} rows={rows}
          columns={[
            { key: "name", header: "Customer", rowHeader: true, cell: (r) => r.name },
            { key: "students", header: "Students under it", cell: (r) => r.students },
            { key: "makes", header: "What it makes", cell: (r) => r.makes },
            { key: "do", header: "What you can do", quiet: true, cell: (r) => (r.aim !== null || r.act === null
              ? <>{r.aim?.words}{r.aim && <> <Link href={r.aim.href}>{r.aim.label}<span className="visually-hidden">: {r.name}</span></Link></>}</>
              : <MakeFamily name={r.name} act={r.act} onDone={(d) => onDone(r.name, d)} />) },
          ]} />
      )}
    </>
  );
}

function MakeFamily({ name, act, onDone }: { name: string; act: () => Promise<Done>; onDone: (r: Done) => void }) {
  const [pending, start] = useTransition();
  const press = () => { if (!pending) start(async () => onDone(await safely(() => act(), failed))); };
  return (
    <div className="row-actions">
      <Button variant="secondary" size="sm" busy={pending} onClick={press}>
        {pending ? "Making the family…" : "Create a family from this"}<span className="visually-hidden">: {name}</span>
      </Button>
    </div>
  );
}
