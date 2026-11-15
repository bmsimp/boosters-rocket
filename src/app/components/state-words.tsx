/**
 * A state line (DESIGN.md): an icon and the state in words, so the color only confirms what the words say. Done is a
 * tick, still to do an alert circle, waived a struck circle in the secondary ink. For parent and staff pages alike.
 */
const ICONS = {
  done: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>,
  todo: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 5v3.5" /><circle cx="8" cy="11" r=".6" fill="currentColor" /></svg>,
  waived: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M5 8h6" /></svg>,
} as const;

export function StateWords({ state, words }: { state: keyof typeof ICONS; words: string }) {
  return <span className={`state ${state}`}>{ICONS[state]}{words}</span>;
}
