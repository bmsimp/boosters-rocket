// The words of a change of company (stage 4's slice M8), each in one constant, so the owner's change to any of them is
// one edit: the switch page's lists, its checkbox and press, the refusal on the setup page, the Disconnect warning and
// the line that sends staff to Accounting links. US English, in PRODUCT.md's voice.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const SWITCH_PAGE = "/staff/settings/quickbooks/switch";
export const LINKS_PAGE = "/staff/links";

export type SwitchCounts = {
  links: { families: number; students: number; guardians: number };
  waitingRequests: number; unpaidBuyouts: number; paidBuyouts: number;
  kept: { families: number; students: number; guardians: number };
};

export const SWITCH_WORDS = {
  title: "Connect a different QuickBooks company",
  lede: "This moves the portal to another QuickBooks company, for example from a sandbox trial to the club's real books. "
    + "The families, students and guardians stay just as they are. What belonged to the earlier company's books ends, and each family is linked to the new company's customers again.",
  endsTitle: "What a switch ends",
  ends: (c: SwitchCounts): string[] => [
    `Every link between the portal's records and the earlier company's customers: ${plural(c.links.families, "family link", "family links")}, ${plural(c.links.students, "student link", "student links")} and ${plural(c.links.guardians, "guardian link", "guardian links")}. You link them again on Accounting links.`,
    "What each family owes, as the portal last read it. Families see that their balance isn't available until they are linked and the new company is read.",
    `${plural(c.waitingRequests, "request", "requests")} still waiting to be sent to the earlier company. ${c.waitingRequests === 1 ? "It is" : "They are"} given up, and nothing more is sent there.`,
    `${plural(c.unpaidBuyouts, "unpaid volunteer buy-out", "unpaid volunteer buy-outs")}. Each one ends, and any that may leave something to settle is listed for the treasurer on Reconciliation; any invoice made for one stays in the earlier company's books, to settle there.`,
    "The product or service chosen for each payment and buy-out requirement. You choose each one again from the new company's list on the requirement's page in Seasons; until then, a payment requirement has no invoice to show and families can't choose to pay instead of volunteering.",
    "The membership shape. You choose it again for the new company in step 3.",
  ],
  keptTitle: "What is kept",
  kept: (c: SwitchCounts): string[] => [
    `Every family, student and guardian: ${plural(c.kept.families, "family", "families")}, ${plural(c.kept.students, "student", "students")} and ${plural(c.kept.guardians, "guardian row", "guardian rows")}.`,
    "Every sign-in, session and welcome: parents keep signing in as they do now.",
    "The seasons' ticks, waivers and chosen lists, and all volunteering: sign-ups, check-ins and credit.",
    "Every signed form, still downloadable by its family and by staff.",
    `${plural(c.paidBuyouts, "paid volunteer buy-out", "paid volunteer buy-outs")}, which keep counting.`,
  ],
  backupTitle: "Before you start",
  backup: "Take a backup first: on the server, in ~/booster-rocket/deploy, run docker compose run --rm backup --now.",
  disconnectFirst: "QuickBooks is connected now. Disconnect it first, from QuickBooks settings, then come back here.",
  confirm: "I understand that every family's link to the books ends, and that each family is linked to the new company again on Accounting links.",
  press: "Switch companies: sign in to Intuit",
  notConfirmed: "Check the box to say you understand what a switch ends, then try again.",
  setupLink: "Connect a different company",
  setupHint: "Moving the portal to another QuickBooks company ends every family's link to the books.",
} as const;

/** The setup page's words for a different company refused with no ask (`roster_company`). */
export const ROSTER_COMPANY_REFUSED = "That is a different QuickBooks company from the one the portal's families were read from, so nothing was connected and nothing was changed. "
  + "To reconnect the club's company, start again and choose it in Intuit. To move the portal to this other company, choose Connect a different company first: it lists what a switch ends and keeps.";

/** The settings view's warning beside Disconnect, while people can sign in. */
export const disconnectWarning = (people: number) =>
  `${plural(people, "person", "people")} can sign in to the portal now. Reconnecting this same QuickBooks company after a disconnect keeps everything as it is for them. `
  + "Connecting a different company ends every family's link to the books, until each is linked again.";

/** Said, to someone who may link families, while the roster's company has active families with no link. */
export const relinkLine = (families: number) =>
  `${plural(families, "family has", "families have")} no link to this QuickBooks company's customers yet. Link ${families === 1 ? "it" : "them"} on Accounting links, so ${families === 1 ? "its" : "their"} balance can be shown.`;
