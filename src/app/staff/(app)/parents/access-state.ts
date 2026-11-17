import type { AccessKind } from "@/lib/parents/directory";

/** How a person's access to a family is drawn as a state line: the words come with it, the icon only repeats them. */
export const accessState = (kind: AccessKind): "done" | "todo" | "waived" => (kind === "can" ? "done" : kind === "blocked" ? "waived" : "todo");
