/**
 * The four tones a status can have, everywhere: done (green), due (amber: still to do, due soon), late (red: past due,
 * a problem) and neutral (gray: not started, waived, nothing asked, a note). A tone is always shown with its words and
 * an icon: color never carries it alone.
 */
export type Tone = "done" | "due" | "late" | "neutral";

/** The words a tone says when the caller gives none of its own. */
export const TONE_WORD: Record<Tone, string> = { done: "Done", due: "To do", late: "Overdue", neutral: "Not started" };
