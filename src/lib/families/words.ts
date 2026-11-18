/**
 * How a page names an app family or student record (stage 1 of the app-owned families spec). A record whose name the
 * portal never knew stores none (`family.name` and `student.name` are null), and is said so in words, never shown as a
 * made-up name. QuickBooks text: shown as text only.
 */
export function recordNameWords(name: string | null, kind: "family" | "student"): string {
  if (name !== null && name.trim() !== "") return name;
  return kind === "family" ? "A family whose name the portal doesn't know" : "A student whose name the portal doesn't know";
}
