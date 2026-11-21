import type { AccessKind } from "@/lib/parents/directory";

/**
 * How a person's access to a family is drawn as a state line: the words come with it, the icon only repeats them. A
 * person who can sign in but hasn't chosen a password yet ("Hasn't chosen a password yet", accessWords()) is still to
 * do: their access is open, but they can't sign in until they choose one.
 */
export const accessState = (kind: AccessKind, hasPassword: boolean): "done" | "todo" | "waived" =>
  (kind === "can" ? (hasPassword ? "done" : "todo") : kind === "blocked" ? "waived" : "todo");
