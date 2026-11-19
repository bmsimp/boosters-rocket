import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { loadRosterPage } from "@/lib/roster/queries";
import { isFamilyCreateItem, loadMadeAfterGivingUp, loadOpenWrites, TRY_AGAIN_NEEDS_LINKING, waitingWords, type GivenUpMadeView, type QueueView } from "@/lib/roster/queue";
import { loadBalances } from "@/lib/money/balances";
import { linksOfCustomers } from "@/lib/families/links";
import { LocalTime } from "@/app/components/local-time";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { WorthALook } from "../balances/worth-a-look";
import { OneButton, TextAction } from "../seasons/forms";
import { giveUpAction, linkMadeStudentAction, sendPortalValueAction, tryAgainAction } from "../roster/write-actions";
import { keptWordsFor, portalValueStamp, TAKEN_NAME_KEPT } from "@/lib/roster/writes";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { BuyoutsToLook } from "./buyouts";
import { CustomersWithNoFamily } from "./no-family";
import { familyPage } from "@/app/staff/(app)/family-pages";

export const metadata = { title: "Reconciliation" };
export const dynamic = "force-dynamic";

/** What a short code means to staff. The code itself is shown beside it, for whoever looks into it further. */
const CODE_WORDS: Record<string, string> = {
  token_busy: "QuickBooks was busy with another request", http_429: "QuickBooks asked the portal to slow down", unreachable: "QuickBooks couldn't be reached",
  timeout: "QuickBooks didn't answer in time", bad_answer: "QuickBooks' answer couldn't be read", moved_on: "the record changed in QuickBooks since, so it wasn't sent again",
  gone: "the record is no longer on the roster", fault_5010: "the record changed in QuickBooks since", fault_6240: "the name is taken in QuickBooks",
  // Making someone inactive (src/lib/roster/writes.ts): never sent while they owe, and what QuickBooks refused, in words.
  open_balance: "they owe something in QuickBooks, so they weren't made inactive: it has to be paid or written off there first, then give this up and ask again",
  fault_6220: "QuickBooks says there is a balance on their account: it has to be settled there first (paid or written off, or a credit used or refunded)",
  fault_800: "QuickBooks won't make it inactive while customers under it are still active",
  not_the_customer: "QuickBooks answered about another record, so nothing was sent",
  no_balance: "QuickBooks didn't say what they owe, so nothing was sent",
  // QuickBooks took it, or may have, and the portal finishes it on its side after its next read (src/lib/roster/queue.ts).
  cache_failed: "QuickBooks made the change, but the portal couldn't take it in at the time: it finishes it after its next read of QuickBooks, sending nothing again",
  answer_other: "QuickBooks answered about another record, so the portal looks for the change after its next read of QuickBooks, sending nothing again",
  made_unmatched: "QuickBooks made a customer for it, but not under the name, family and type sent, so it won't be sent again: check it in QuickBooks, then give it up",
  finish_failed: "QuickBooks has the change, but the portal couldn't finish it on its side: it tries again later",
  // A family saved in the portal first, whose customer QuickBooks made, found linked to another family meanwhile (stage 3's slice 9d).
  customer_has_family: "QuickBooks made the customer, but another family in the portal is linked to it already, so this family was left unlinked and nothing will be sent again: check both in QuickBooks, then give this up",
  family_has_customer: "QuickBooks made the customer, but this family in the portal was linked to another customer meanwhile, so the new customer was left with no family and nothing will be sent again: check both in QuickBooks, then give this up",
};
const codeWords = (code: string | null) => (code === null ? null
  : CODE_WORDS[code] ?? (/^http_5\d\d/.test(code) ? "QuickBooks had a problem of its own" : /^token_/.test(code) ? "the portal couldn't get a key to QuickBooks" : "QuickBooks refused it"));

/** The changes in one state, a row each: what, who asked and when, the tries, the last answer, and what can be done. */
function Writes({ items, caption, canChange, mayLink }: { items: QueueView[]; caption: string; canChange: boolean; mayLink: boolean }) {
  const columns: Column<QueueView>[] = [
    { key: "what", header: "Change", rowHeader: true, cell: (i) => (
      <>{i.words}<span className="when">{i.state === "stuck" ? "Stuck: it won't be tried again until someone asks" : waitingWords(i)}</span>{i.moneyNote ? <span className="when">{i.moneyNote}</span> : null}</>) },
    { key: "asked", header: "Asked", cell: (i) => <><LocalTime iso={i.askedAt} />{i.askedBy ? <span className="when">by {i.askedBy}</span> : null}</> },
    { key: "tries", header: "Tries", cell: (i) => (
      <>{i.tries} {i.tries === 1 ? "time" : "times"}, last <LocalTime iso={i.lastTriedAt} />{i.state === "waiting" && i.nextTryAt ? <span className="when">Next try <LocalTime iso={i.nextTryAt} /></span> : null}</>) },
    { key: "last", header: "Last time", cell: (i) => { const words = codeWords(i.lastCode); return words ? `${words} (${i.lastCode})` : "No answer recorded"; } },
    { key: "family", header: "Family", cell: (i) => (i.familyId ? <Link href={familyPage(i.familyId)}>Open the family</Link> : "None") },
    ...(canChange ? [{ key: "do", header: "What you can do", quiet: true, cell: (i: QueueView) => (
      <div className="row-actions">
        {/* A family's create makes its customer and links it: only for staff who may link families to accounting (tryAgainNow()). */}
        {isFamilyCreateItem(i.write) && !mayLink ? <Notice tone="info" live="none">{TRY_AGAIN_NEEDS_LINKING}</Notice>
          : <OneButton label="Try again now" pendingLabel="Asking…" act={tryAgainAction.bind(null, i.id)} />}
        <details className="more"><summary>Give up</summary>
          <TextAction field="Why? (kept in the audit log)" label="Give up" pendingLabel="Giving up…" maxLength={500} multiline act={giveUpAction.bind(null, i.id)} />
        </details>
      </div>) }] : []),
  ];
  return <DataTable caption={caption} captionHidden columns={columns} rows={items} rowKey={(i) => i.id} />;
}

/** Why a refused rename or move isn't offered "Send the portal's value", by what the cache shows (QueueView.notOffered). */
const NOT_OFFERED: Record<NonNullable<QueueView["notOffered"]>, string> = {
  taken: TAKEN_NAME_KEPT,
  inactive: "QuickBooks has this customer inactive, and the portal never makes a customer active again, so the portal's value isn't sent: give it up here, or make the customer active in QuickBooks first.",
  not_on_roster: "This customer isn't on the roster the portal last read from QuickBooks, so the portal's value isn't sent: look for the customer in QuickBooks, then give this up here.",
  create_family_first: "The family the student was moved to has no customer in QuickBooks yet, so there is nowhere to put them there. Create the family in QuickBooks first, with “Create in QuickBooks and link” on its page; the portal's move can be sent from here after that.",
};

/**
 * The changes saved in the portal first that didn't go through (stage 3's slice 9e), a row each: what, why in words
 * saying who stopped it (QuickBooks, the portal holding it back, or the portal unable to send it; never a code), what
 * QuickBooks has now for a rename (the roster cache's name) or a move (the family the cache has the student under, with
 * whose invoices each family sees meanwhile: slice 9f), who asked and when, the family's page, and, for staff who
 * may change families, "Send the portal's value" (bound to what the row showed, sealed so a value the form sends back
 * that isn't it is refused) and "Give up". Such a change is never tried again by itself.
 */
function Refused({ items, canChange }: { items: QueueView[]; canChange: boolean }) {
  const columns: Column<QueueView>[] = [
    { key: "what", header: "Change", rowHeader: true, cell: (i) => <>{i.words}<span className="when">{waitingWords(i)}</span>{i.moneyNote ? <span className="when">{i.moneyNote}</span> : null}</> },
    { key: "why", header: "Why it didn't go through", cell: (i) => keptWordsFor(i.write, i.lastCode, i.holds) },
    { key: "asked", header: "Asked", cell: (i) => <><LocalTime iso={i.askedAt} />{i.askedBy ? <span className="when">by {i.askedBy}</span> : null}</> },
    { key: "family", header: "Family", cell: (i) => (i.familyId ? <Link href={familyPage(i.familyId)}>Open the family</Link> : "None") },
    ...(canChange ? [{ key: "do", header: "What you can do", quiet: true, cell: (i: QueueView) => {
      // Offered only where it can go through: a name QuickBooks refused as taken is renamed on the family's page instead
      // (which takes its place, and is sent), a customer QuickBooks has inactive is never made active again by the
      // portal, one the roster doesn't hold isn't sent to, and a move into a family with no customer in QuickBooks waits
      // for that family to be made there. The press is bound to what the row shows (QueueView.shown).
      const instead = i.mayResend || i.notOffered === null ? null : NOT_OFFERED[i.notOffered];
      return (
        <div className="row-actions">
          {instead === null
            ? <OneButton label="Send the portal's value" pendingLabel="Reading QuickBooks, then sending…" act={sendPortalValueAction.bind(null, i.id, i.shown, portalValueStamp(i.id, i.shown))} />
            : <Notice tone="info" live="none">{instead}</Notice>}
          <details className="more"><summary>Give up</summary>
            <p className="hint">The portal keeps its own value, and QuickBooks keeps what it has.</p>
            <TextAction field="Why? (kept in the audit log)" label="Give up" pendingLabel="Giving up…" maxLength={500} multiline act={giveUpAction.bind(null, i.id)} />
          </details>
        </div>);
    } }] : []),
  ];
  return <DataTable caption="Changes that didn't go through, kept in the portal" captionHidden columns={columns} rows={items} rowKey={(i) => i.id} />;
}

/**
 * The creates staff gave up here that QuickBooks made all the same (stage 3's slice 9d, the lead's decision): a given-up
 * change stays given up, so nothing in the portal is linked to the customer QuickBooks made, and no second one is made
 * for the record. A family's or member's is brought in from Customers with no family; a student's sits under its
 * family, so it is linked to the student here ("Link the student to it", for staff who may change families and link
 * them to accounting). Names are QuickBooks text, shown as text only.
 */
function MadeAfterGivingUp({ items, linking, canChange, rosterTag }: { items: GivenUpMadeView[]; linking: boolean; canChange: boolean; rosterTag: string }) {
  const bringIn = linking ? "Bring it in with “Create a family from this” under Customers with no family below"
    : "Someone who may link families to accounting can bring it in from Customers with no family on this page";
  const student = (m: GivenUpMadeView) => {
    const say = "A student customer that no student in the portal is linked to. If it is the student the portal saved first, link the two; if it isn't wanted, make it inactive in QuickBooks.";
    if (m.studentId === null) return say;
    if (!linking || !canChange || rosterTag === "none") return <>{say}<span className="when">Linking it takes the permissions to change families and to link them to accounting.</span></>;
    return <>{say}<OneButton label="Link the student to it" pendingLabel="Linking…" act={linkMadeStudentAction.bind(null, rosterTag, m.queueId)} /></>;
  };
  return (
    <section className="box" aria-labelledby="made-anyway-h"><h2 id="made-anyway-h">Made in QuickBooks after it was given up ({items.length})</h2>
      <p>These were given up here while QuickBooks may still have been making them, and QuickBooks did make them. Nothing in the portal is linked to them, and no second customer is made for them.</p>
      <DataTable caption="Each customer QuickBooks made for a change given up" captionHidden rows={items} rowKey={(m) => m.queueId} columns={[
        { key: "name", header: "In QuickBooks", rowHeader: true, cell: (m) => m.name },
        { key: "what", header: "What to do", cell: (m) => (m.role === "student"
          ? student(m)
          : `A ${m.role} customer that no ${m.role} in the portal is linked to. ${bringIn}, then make the ${m.role} the portal saved first inactive on its page; if it isn't wanted, make it inactive in QuickBooks.`) },
        { key: "family", header: "Saved first", cell: (m) => (m.familyPage ? <Link href={familyPage(m.familyPage)}>Open the family</Link> : "None") },
      ]} />
    </section>
  );
}

/**
 * What doesn't line up between the portal and QuickBooks, in one place (v1 spec §6.3, §8.3): staff changes still
 * waiting to reach QuickBooks or stuck, the roster's Needs attention list, for staff who may link families to
 * accounting the customers no family is linked to (stage 3's slice 10), and, for staff who may see money, the
 * families whose QuickBooks balance isn't what their invoices add up to. It lists many families, so opening it is not
 * audited as a read of one; each family's own page is. Names are QuickBooks text, shown as text only.
 */
export default async function ReconciliationPage() {
  const ctx = await requireStaffPage("Roster.Read");
  const money = can(ctx.effective, "Finance.Balance.Read");
  // Read before the roster, as every page that sends it does: a write refuses a page shown another company's roster.
  const rosterTag = await currentRosterTag();
  const [writes, roster, balances, madeAnyway] = await Promise.all([loadOpenWrites({ showAmounts: money }), loadRosterPage(), money ? loadBalances() : Promise.resolve(null),
    loadMadeAfterGivingUp()]);
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite");
  // Customers no family is linked to, with "Create a family from this": only for staff who may link families to accounting.
  const linking = can(ctx.effective, "Accounting.Link.ReadWrite");
  const stuck = writes.filter((w) => w.state === "stuck"), waiting = writes.filter((w) => w.state === "waiting"), refused = writes.filter((w) => w.state === "refused");
  // The customers with a family page (the roster's families, or members in flat books), each by its family record, found
  // through the family kind of link in one lookup for the list: a customer with none links nowhere.
  const withPage = !roster.roster ? [] : roster.roster.kind === "flat" ? roster.roster.members.map((m) => m.qboId) : roster.roster.families.map((f) => f.customer.qboId);
  const pageOf = (await linksOfCustomers({ families: withPage, students: [] })).familyOfCustomer;
  return (
    <main className="wrap single">
      <h1 className="page-title">Reconciliation</h1>
      <p className="lede">Where the portal and QuickBooks don&apos;t agree yet, and what needs someone to look at it.</p>

      <section className="box" aria-labelledby="writes-h"><h2 id="writes-h">Changes waiting to reach QuickBooks</h2>
        {writes.length === 0 ? <Notice tone="done" live="none">Nothing is waiting: every change staff made has reached QuickBooks.</Notice> : (
          <>
            <p>QuickBooks couldn&apos;t take these when they were asked for. The worker tries a waiting change again, at longer and longer gaps;
              one QuickBooks may already have made is first looked for in a fresh copy of the roster, so nothing is made twice or overwritten.
              One QuickBooks took that the portal couldn&apos;t take in at the time waits here too, until the portal finishes it on its side.
              A stuck change waits for you: try it again, or give it up and make it in QuickBooks.
              A change saved in the portal first that didn&apos;t go through (QuickBooks refused it, the portal held it back as QuickBooks has something else, or it couldn&apos;t be sent) is kept in the portal: send the portal&apos;s value again on purpose, or give it up and leave QuickBooks as it is.</p>
            {refused.length > 0 && <><h3 className="table-head">Not in QuickBooks, kept in the portal ({refused.length})</h3><Refused items={refused} canChange={canChange} /></>}
            {stuck.length > 0 && <><h3 className="table-head">Stuck ({stuck.length})</h3><Writes items={stuck} caption="Stuck changes" canChange={canChange} mayLink={linking} /></>}
            {waiting.length > 0 && <><h3 className="table-head">Waiting ({waiting.length})</h3><Writes items={waiting} caption="Changes waiting" canChange={canChange} mayLink={linking} /></>}
          </>
        )}
      </section>

      {madeAnyway.length > 0 && <MadeAfterGivingUp items={madeAnyway} linking={linking} canChange={canChange} rosterTag={rosterTag} />}

      <BuyoutsToLook showAmounts={money} canChange={canChange} />

      {linking && <CustomersWithNoFamily mayChangeFamilies={canChange} />}

      <section className="box" aria-labelledby="attention-h"><h2 id="attention-h">Needs attention in the roster{roster.attention.length ? ` (${roster.attention.length})` : ""}</h2>
        {!roster.roster ? <Notice tone="warning" live="none">The roster can&apos;t be shown right now. <Link href="/staff/roster">Open the roster</Link> to see why.</Notice>
          : roster.attention.length === 0 ? <Notice tone="done" live="none">Nothing: the roster is tidy.</Notice> : (
            <DataTable caption="What to tidy, for each customer" captionHidden rowKey={(a) => a.key} rows={roster.attention.map((a, i) => ({ ...a, key: `${a.rule}-${a.qboId ?? a.name}-${i}` }))}
              columns={[
                { key: "name", header: "Customer", rowHeader: true, cell: (a) => { const at = a.qboId === null ? undefined : pageOf.get(a.qboId); return at ? <Link href={familyPage(at)}>{a.name}</Link> : a.name; } },
                { key: "detail", header: "What to tidy", cell: (a) => a.detail },
              ]} />
          )}
      </section>

      {balances && (
        <section className="box" aria-labelledby="look-h"><h2 id="look-h">Money worth a look</h2>
          {balances.worthALook.length === 0 ? <Notice tone="done" live="none">Nothing: every family&apos;s balance in QuickBooks is what its open invoices add up to, as last checked.</Notice> : (
            <>
              <p>QuickBooks&apos; own balance for these customers isn&apos;t what their open invoices add up to. It may be a credit, a payment not yet applied, or a charge that isn&apos;t an invoice. Parents see the invoices.</p>
              <WorthALook rows={balances.worthALook} />
            </>
          )}
        </section>
      )}
    </main>
  );
}
