/**
 * The tones a status can have, everywhere: done (green: paid, signed, finished), due (amber: still to do, due soon),
 * late (red: past due, a problem), info (blue: a note, something to know) and neutral (gray: not started, waived,
 * nothing asked). The four colored ones are the brand's fixed status set (brand/BRAND.md); a club's color never
 * replaces them. A tone is always shown with its words and an icon: color never carries it alone.
 */
export type Tone = "done" | "due" | "late" | "info" | "neutral";

/** The words a tone says when the caller gives none of its own. */
export const TONE_WORD: Record<Tone, string> = { done: "Done", due: "To do", late: "Overdue", info: "Note", neutral: "Not started" };
