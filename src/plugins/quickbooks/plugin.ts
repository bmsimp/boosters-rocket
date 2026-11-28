// The QuickBooks Online plugin's manifest (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md, section 3).
// Slice P1 declares what exists today: its code is still under src/lib (src/lib/quickbooks/, roster/, money/,
// buyouts/, accounting/) and moves here in slice P7. Plain data: it imports no QuickBooks code, so the core reading
// the plugin list (src/plugins/index.ts) pulls none in.
import { ACTION_NAMES } from "@/lib/audit/actions";
import { ACCOUNTING_ABILITIES, type Plugin } from "../types";

/** The audit actions QuickBooks brings: whole families of them by prefix, and a few of the roster's by name. */
const ACTION_PREFIXES = ["accounting.", "money.", "quickbooks.", "roster.customer.", "roster.write.", "roster.writes.", "settings.quickbooks.", "volunteer.buyout.", "volunteer.buyouts."];
const ACTIONS = ["roster.refresh", "roster.refresh.failed", "roster.cleared", "roster.family.created_in_quickbooks", "roster.family.deactivate", "roster.record.follows",
  "roster.student.linked_after_giving_up", "roster.student.move", "settings.membership.save", "season.requirement.buyout"];
const ours = (action: string) => ACTIONS.includes(action) || ACTION_PREFIXES.some((p) => action.startsWith(p));

export const quickbooks = {
  key: "quickbooks",
  kind: "accounting",
  name: "QuickBooks Online",
  nouns: { books: "QuickBooks", customer: "customer", customers: "customers" },
  // QuickBooks declares every optional ability: the customer create, rename, move (the change of parent) and make
  // inactive after the balance read, the phone and address update, the email field update, and the buy-out invoice's
  // create and void.
  abilities: ACCOUNTING_ABILITIES,
  permissions: [
    { name: "Settings.QuickBooks.ReadWrite", adminOnly: true },
    { name: "Finance.Balance.Read", adminOnly: false },
    { name: "Accounting.Link.ReadWrite", adminOnly: false },
  ],
  auditActions: Object.fromEntries(Object.entries(ACTION_NAMES).filter(([action]) => ours(action))),
  tables: ["qbo_connection", "qbo_relay", "qbo_customer_type", "qbo_customer", "qbo_item", "family_money", "write_queue", "qbo_check_run", "qbo_check_record",
    "accounting_link", "accounting_link_ended", "buyout"],
  settings: "quickbooks",
  pages: [
    { path: "/staff/settings/quickbooks", door: "staff", permission: "Settings.QuickBooks.ReadWrite" },
    { path: "/staff/settings/quickbooks/setup", door: "staff", permission: "Settings.QuickBooks.ReadWrite" },
    { path: "/staff/settings/quickbooks/check", door: "staff", permission: "Settings.QuickBooks.ReadWrite" },
    { path: "/staff/settings/quickbooks/switch", door: "staff", permission: "Settings.QuickBooks.ReadWrite" },
    { path: "/staff/money", door: "staff", permission: null },
    { path: "/staff/balances", door: "staff", permission: "Finance.Balance.Read" },
    { path: "/staff/balances/[familyId]", door: "staff", permission: "Finance.Balance.Read" },
    { path: "/staff/reconciliation", door: "staff", permission: "Roster.Read" },
    { path: "/staff/links", door: "staff", permission: "Accounting.Link.ReadWrite" },
    { path: "/staff/roster/[id]/buyouts", door: "staff", permission: "Roster.Read" },
    { path: "/payments", door: "parent", permission: null },
  ],
  jobs: [
    { name: "quickbooks.token_refresh", due: "before the access token expires" },
    { name: "roster.refresh", due: "every few hours, and when staff or a take-in ask" },
    { name: "roster.write_queue", due: "every minute while a write waits" },
    { name: "money.read_all", due: "daily" },
    { name: "buyouts.check", due: "daily" },
    { name: "parents.contact_take_in", due: "once, after a roster read that keeps billing addresses" },
  ],
  slots: {},
} as const satisfies Plugin;
