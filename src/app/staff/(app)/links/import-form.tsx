"use client";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { useLinkAnswer } from "./link-press";

// The reviewed import's form (stage 4's slice M6): a tick for each family the review proposes, each ticked to begin
// with, and one press, bound to the server action with the roster tag and the stamp the page drew. It is given only the
// customer ids, the names it shows, the count and the stamp; the review's words around it are drawn by the server.
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };

/** The press's words, with the ticked count on it (the lead's decision 4: one constant). */
export const IMPORT_PRESS = (n: number) => `Make these families (${n})`;

const Ticks = createContext<{ ticked: ReadonlySet<string>; flip: (id: string) => void }>({ ticked: new Set(), flip: () => {} });

/**
 * The form: `ids`, the families in the review's order; `act`, the press bound to the roster tag and the stamp, given the
 * ticked ids in that order and how many. The ticks inside it (ImportTick) and the press at its end share what is ticked.
 */
export function ImportForm({ ids, act, children }: { ids: string[]; act: (ticked: string[], count: number) => Promise<Done>; children: ReactNode }) {
  const add = useLinkAnswer();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(ids));
  const [pending, start] = useTransition();
  const flip = (id: string) => setTicked((had) => { const next = new Set(had); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const chosen = ids.filter((id) => ticked.has(id));
  const go = () => {
    if (pending) return;
    if (chosen.length === 0) { add({ ok: false, errors: ["Tick at least one family to make. Nothing was made."] }); return; }
    start(async () => add(await safely(() => act(chosen, chosen.length), failed)));
  };
  return (
    <Ticks.Provider value={{ ticked, flip }}>
      {children}
      <div className="row-actions">
        <button type="button" className="btn" aria-disabled={pending} onClick={go}>{pending ? "Making the families…" : IMPORT_PRESS(chosen.length)}</button>
      </div>
    </Ticks.Provider>
  );
}

/** One family's tick, with its name (the books' text, shown as text). */
export function ImportTick({ id, name }: { id: string; name: string }) {
  const { ticked, flip } = useContext(Ticks);
  return <label><input type="checkbox" checked={ticked.has(id)} onChange={() => flip(id)} /> {name}</label>;
}
