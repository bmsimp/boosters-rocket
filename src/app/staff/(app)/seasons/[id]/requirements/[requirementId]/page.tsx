import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { isUuid } from "@/lib/seasons/ids";
import { describeRequirement, getRequirementSetup } from "@/lib/seasons/setup";
import { candidatesFor, loadSeasonFamilies } from "@/lib/seasons/subjects";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { listItems, itemsReadAt, requirementItem } from "@/lib/money/items";
import { CalendarDate } from "@/app/components/calendar-date";
import { LocalTime } from "@/app/components/local-time";
import { dateWords, shiftTimeWords } from "@/lib/volunteer/clock";
import { shiftsCountingToward } from "@/lib/volunteer/setup";
import { CoverageForm, OneButton, RequirementForm } from "../../../forms";
import { moveRequirementAction, removeRequirementAction, setCoverageAction, updateRequirementAction } from "../../../actions";
import { PaymentItemForm } from "../../../payment-item";
import { chooseItemAction, readItemsAction } from "../../../payment-actions";
import { FormTemplateBox } from "../../../form-template";
import { BuyoutBox } from "../../../buyout";

export const metadata = { title: "Requirement" };
export const dynamic = "force-dynamic";

export default async function RequirementPage({ params }: { params: Promise<{ id: string; requirementId: string }> }) {
  const ctx = await requireStaffPage("Season.Steps.Read");
  const { id, requirementId } = await params;
  const found = isUuid(id) && isUuid(requirementId) ? await getRequirementSetup(requirementId) : null;
  // The address names the season too: a requirement asked for under another season isn't there.
  if (!found || found.season.id !== id) notFound();
  const { requirement: r, step, season, recorded, place } = found;
  const canChange = can(ctx.effective, "Season.Steps.ReadWrite");
  // The tag first: a change of company before the roster is read leaves it the older one, and the save is refused.
  const rosterTag = await currentRosterTag();
  const families = await loadSeasonFamilies();
  const candidates = candidatesFor(r.appliesTo, families);
  // The chosen list names the app's own families or students; the page and the form carry their ids as text.
  const chosen = new Set(r.coveredIds.map(String));
  const onRoster = new Set(candidates.map((c) => String(c.id)));
  const noun = r.appliesTo === "family" ? "families" : "students";
  const [item, items, itemsAt] = r.kind === "payment" ? await Promise.all([requirementItem(r.id), listItems(), itemsReadAt()]) : [null, [], null];
  const seesVolunteer = can(ctx.effective, "Volunteer.Event.Read");
  const shifts = r.kind === "volunteer" ? await shiftsCountingToward(r.id) : [];
  const back = `/staff/seasons/${season.id}`;
  return (
    <main className="wrap single">
      <h1 className="page-title">{r.title}</h1>
      <p className="lede">In {step.name}, {season.name}. <Link className="link-line" href={back}>Back to {season.name}</Link>
        {can(ctx.effective, "Season.Progress.Read") && <> · <Link className="link-line" href={`/staff/seasons/progress/${r.id}`}>Who has done it</Link></>}</p>

      <section className="box" aria-labelledby="req-h"><h2 id="req-h">Settings</h2>
        <p>{describeRequirement(r)}{r.dueOn ? <> · Due <CalendarDate iso={r.dueOn} /></> : null}</p>
        {canChange && (
          <>
            <p className="hint">The kind, and whether it is asked of each family or each student, are set when a requirement is added and stay as they are.</p>
            <RequirementForm kind={r.kind} initial={{ title: r.title, required: r.required, amount: r.amount, amountUnit: r.amountUnit, dueOn: r.dueOn }} save={updateRequirementAction.bind(null, r.id)} />
          </>
        )}
      </section>

      {r.kind === "payment" && (
        <section className="box" aria-labelledby="item-h"><h2 id="item-h">Paid by</h2>
          <p>{item
            ? <>Met for {r.appliesTo === "family" ? "a family when its invoices" : "a student when the invoices raised on that student"} carrying <b>{item.name ?? `the QuickBooks product or service numbered ${item.qboId}`}</b> are all paid. Parents read &ldquo;Paid&rdquo;, &ldquo;Not paid yet&rdquo; with what is left to pay, or &ldquo;No invoice yet&rdquo;.</>
            : <>No product or service is chosen yet, so it reads &ldquo;No invoice yet&rdquo; for everyone.</>}</p>
          {item && !item.active && <p className="hint">It isn&apos;t an active product or service in the list last read from QuickBooks.</p>}
          {canChange && (
            <>
              {items.length === 0
                ? <p className="hint">No list of products and services has been read from QuickBooks yet.</p>
                : <PaymentItemForm chosen={item?.qboId ?? null} save={chooseItemAction.bind(null, r.id, rosterTag)}
                    items={items.filter((i) => i.active || i.qboId === item?.qboId).map((i) => ({ qboId: i.qboId, label: i.active ? i.name : `${i.name} (inactive)` }))} />}
              {itemsAt && <p className="hint">The list was read from QuickBooks <LocalTime iso={itemsAt} />.</p>}
              <OneButton label="Read the list from QuickBooks" pendingLabel="Reading…" act={readItemsAction} />
            </>
          )}
        </section>
      )}

      {r.kind === "form" && <FormTemplateBox requirementId={r.id} appliesTo={r.appliesTo} canChange={canChange} />}

      <section className="box" aria-labelledby="cover-h"><h2 id="cover-h">Who it is asked of</h2>
        <p>{r.covers === "everyone" ? `Everyone: every ${r.appliesTo === "family" ? "family" : "student"} on the roster.`
          : `A chosen list: ${[...chosen].filter((id) => onRoster.has(id)).length} of the ${noun} on the roster.`}</p>
        {r.covers === "chosen" && (
          <ul className="lines">{candidates.filter((c) => chosen.has(String(c.id))).map((c) => (
            <li key={String(c.id)}><div><span className="what">{c.name}</span>{r.appliesTo === "student" && <span className="when">{c.familyName}</span>}</div></li>))}</ul>
        )}
        {canChange && (
          <details className="more"><summary>Change who it is asked of</summary>
            <CoverageForm covers={r.covers} chosen={[...chosen].filter((id) => onRoster.has(id))} noun={noun}
              candidates={candidates.map((c) => ({ id: String(c.id), label: r.appliesTo === "student" ? `${c.name} (${c.familyName})` : c.name }))}
              save={setCoverageAction.bind(null, r.id, rosterTag)} />
          </details>)}
      </section>

      {r.kind === "volunteer" && (
        <section className="box" aria-labelledby="shifts-h"><h2 id="shifts-h">Shifts that count toward it</h2>
          {shifts.length === 0 ? <p>No shift counts toward it yet. Choose it under &quot;Counts toward&quot; when you add or change a shift{seesVolunteer ? <> on the <Link href="/staff/volunteer">Volunteer</Link> page</> : ""}.</p> : (
            <ul className="lines">{shifts.map((x, i) => (
              <li key={i}><div>
                {seesVolunteer ? <Link className="what" href={`/staff/volunteer/${x.eventId}`}>{x.eventName}</Link> : <span className="what">{x.eventName}</span>}
                <span className="when">{dateWords(x.onDate)}, {shiftTimeWords(x.startsAt, x.endsAt)}{x.cancelled ? " · Cancelled" : ""}</span>
              </div></li>))}</ul>
          )}
          <p className="hint">A shift counts {r.amountUnit === "hours" ? "its length in hours" : "as one shift"} once the person on it checks in with the shift&apos;s code, or staff add the check-in under Volunteer credit. Until then the family sees it as signed up for.</p>
        </section>
      )}

      {r.kind === "volunteer" && <BuyoutBox requirementId={r.id} unit={r.amountUnit} rosterTag={rosterTag} canChange={canChange} />}

      {canChange && place.of > 1 && (
        <section className="box" aria-labelledby="order-h"><h2 id="order-h">Order</h2>
          <p>{place.index + 1} of the {place.of} requirements in {step.name}. Families read them in this order.</p>
          <div className="row-actions">
            {place.index > 0 && <OneButton label="Move earlier" pendingLabel="Moving…" act={moveRequirementAction.bind(null, r.id, "earlier")} />}
            {place.index < place.of - 1 && <OneButton label="Move later" pendingLabel="Moving…" act={moveRequirementAction.bind(null, r.id, "later")} />}
          </div>
        </section>
      )}

      {canChange && (
        <section className="box" aria-labelledby="remove-h"><h2 id="remove-h">Remove</h2>
          {recorded > 0
            ? <p>{recorded === 1 ? "A tick or waiver is" : `${recorded} ticks and waivers are`} recorded against this requirement, so it can&apos;t be removed. Clear them first on its progress page, or make it optional so it no longer holds the step open.</p>
            : <><p>Nothing is recorded against this requirement yet, so it can be removed.</p>
                <OneButton label="Remove this requirement" pendingLabel="Removing…" act={removeRequirementAction.bind(null, r.id)} goTo={back} /></>}
        </section>
      )}
    </main>
  );
}
