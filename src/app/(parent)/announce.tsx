"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * A status line that outlives the rows it speaks for. Cancelling a sign-up or checking someone in redraws the page
 * without the button that was pressed (the row is gone, or reads "Checked in"), so a message kept inside that button's
 * own component would vanish with it, unheard, and the keyboard's place with it. The button tells the line instead
 * (useSay), and the line, which stays, shows the words, says them (role="status") and takes the focus, so a keyboard or
 * screen reader user goes on from where they were. Given nothing from the server.
 */
const Say = createContext<((words: string) => void) | null>(null);

export function Announcer({ children }: { children: React.ReactNode }) {
  const [said, setSaid] = useState({ words: "", n: 0 });
  const line = useRef<HTMLParagraphElement>(null);
  const say = useCallback((words: string) => setSaid((s) => ({ words, n: s.n + 1 })), []);
  useEffect(() => { if (said.n > 0) line.current?.focus(); }, [said.n]);
  return (
    <Say.Provider value={say}>
      {children}
      <p ref={line} role="status" tabIndex={-1} className="volunteer-done announce">{said.words}</p>
    </Say.Provider>
  );
}

/** What a button inside an Announcer calls with its message; null outside one. */
export const useSay = () => useContext(Say);
