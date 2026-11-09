/**
 * A secret's expiry is a calendar date the person typed (2028-11-08), stored as midnight UTC. It is not an instant,
 * so it is shown from its UTC date parts in every time zone; in a zone behind UTC the viewer-local day would be the 7th.
 */
export function formatCalendarDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
}
