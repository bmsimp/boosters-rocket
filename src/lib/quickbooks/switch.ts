// What a change of company would end and keep, counted for the switch page (stage 4's slice M8): staff-only, since it
// counts every family's links, records, requests and buy-outs (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
// Counts only: nothing names a family, a person or a company. Not audited, as a list of many families is not.
import "server-only";
import { and, count, eq, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, buyout, family, guardian, student, writeQueue } from "@/lib/db/schema";
import { LIVE_STATES } from "@/lib/buyouts/rules";
import { getRosterSource } from "@/lib/roster/source";
import { connectionView } from "./connection";

export type SwitchPreview = {
  /** Whether the roster names a company: with none there is nothing to switch from, and a first connect needs no switch. */
  rosterNamesCompany: boolean;
  /** Whether QuickBooks is connected now: a switch starts with Disconnect. */
  connected: boolean;
  /** Ended by a switch: every link to the books, by kind. */
  links: { families: number; students: number; guardians: number };
  /** Requests still to be sent to the roster's company (waiting, stuck or kept refused), given up by a switch. */
  waitingRequests: number;
  /** Unpaid live volunteer buy-outs, ended by a switch and listed for the treasurer. */
  unpaidBuyouts: number;
  /** Paid buy-outs, which keep counting. */
  paidBuyouts: number;
  /** Kept: the app's own records. */
  kept: { families: number; students: number; guardians: number };
};

const UNPAID_LIVE = LIVE_STATES.filter((s) => s !== "paid");
const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);

/** What a change of company would end and keep, as it stands now (open question 16 of the app-owned families spec). */
export async function switchPreview(): Promise<SwitchPreview> {
  const [source, conn, links, queued, unpaid, paid, families, students, guardians] = await Promise.all([
    getRosterSource(), connectionView(),
    db.select({ families: sql<number>`count(${accountingLink.familyId})::int`, students: sql<number>`count(${accountingLink.studentId})::int`,
      guardians: sql<number>`count(${accountingLink.guardianId})::int` }).from(accountingLink),
    db.select({ n: count() }).from(writeQueue).where(inArray(writeQueue.state, ["waiting", "stuck", "refused"])),
    db.select({ n: count() }).from(buyout).where(inArray(buyout.state, [...UNPAID_LIVE])),
    db.select({ n: count() }).from(buyout).where(eq(buyout.state, "paid")),
    db.select({ n: count() }).from(family), db.select({ n: count() }).from(student), db.select({ n: count() }).from(guardian),
  ]);
  const l = links[0];
  return {
    rosterNamesCompany: source !== null, connected: conn.connected,
    links: { families: Number(l?.families ?? 0), students: Number(l?.students ?? 0), guardians: Number(l?.guardians ?? 0) },
    waitingRequests: n(queued), unpaidBuyouts: n(unpaid), paidBuyouts: n(paid),
    kept: { families: n(families), students: n(students), guardians: n(guardians) },
  };
}

/**
 * How many active families have no link to a customer of the roster's company: after a switch, every one, until staff
 * link them again on Accounting links. Zero while the roster names no company.
 */
export async function familiesToLinkAgain(): Promise<number> {
  const source = await getRosterSource();
  if (source === null) return 0;
  return n(await db.select({ n: count() }).from(family).where(and(eq(family.active, true), notExists(
    db.select({ id: accountingLink.id }).from(accountingLink).where(and(eq(accountingLink.familyId, family.id), eq(accountingLink.realmId, source), isNotNull(accountingLink.familyId)))))));
}
