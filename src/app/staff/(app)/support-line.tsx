/**
 * Where staff ask Boosters Rocket for help: its support page, which gives the address to write to and what to put in
 * (the portal's address, what happened, and any "Intuit reference" shown here). Staff pages only, on the Health page and
 * Settings, QuickBooks: a parent asks their own club.
 */
export const SUPPORT_PAGE = "https://boostersrocket.com/support";

export function SupportLine() {
  return <p><a className="link-line" href={SUPPORT_PAGE}>Need help? Contact Boosters Rocket support</a></p>;
}
