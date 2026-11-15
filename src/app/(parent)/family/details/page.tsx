import { requireParentPage } from "@/lib/guards";
import { loadMyContact } from "@/lib/parents/contact-edits";
import { getClubSettings } from "@/lib/settings/club";
import { DetailsBox } from "../../family-boxes";
import { DetailsForm } from "./details-form";

export const metadata = { title: "Update your details" };

/**
 * Where a parent changes their own phone and mailing address (v1 spec §6.2). Whose record this is comes from the
 * session and nothing else: the address of this page has no id in it, and neither has the form.
 *
 * The phone and address are read from QuickBooks as the page opens, since the roster cache keeps no address. When
 * QuickBooks can't be asked, the page shows what the roster last had and no form. A parent whose sign-in has no
 * QuickBooks record of its own gets the same box as on Family, which tells them to ask the club.
 */
export default async function FamilyDetailsPage() {
  const ctx = await requireParentPage("/family/details");
  const [view, club] = await Promise.all([loadMyContact(ctx), getClubSettings()]);
  return (
    <main className="wrap single family-page">
      <h1 className="page-title">Update your details</h1>
      {view.state === "none" ? (
        <DetailsBox who={{ name: ctx.name, email: ctx.email, phone: null }} treasurerEmail={club.treasurerEmail} />
      ) : (
        <>
          <p className="lede">
            {view.me.edits === "family"
              ? <>These are your family&apos;s contact details in the club&apos;s books. Every parent in your family shares them, so a change here changes them for all of you.</>
              : <>Your phone and mailing address, as the club&apos;s books have them. A change here goes straight to the club.</>}
          </p>
          <section className="box" aria-labelledby="who-h">
            <h2 id="who-h">{view.me.edits === "family" ? "Your family" : "You"}</h2>
            <dl className="details">
              <dt>Name</dt><dd>{view.me.name}</dd>
              {view.me.email && <><dt>Email</dt><dd>{view.me.email}</dd></>}
              {view.state === "unavailable" && view.me.phone && <><dt>Phone</dt><dd className="num">{view.me.phone}</dd></>}
            </dl>
            <p className="help">The club changes names and email addresses. {club.treasurerEmail
              ? <>Email the treasurer at <a href={`mailto:${club.treasurerEmail}`}>{club.treasurerEmail}</a> and they&apos;ll update them.</>
              : <>Ask the club and they&apos;ll update them.</>}</p>
          </section>
          {view.state === "ok" ? (
            <section className="box" aria-labelledby="edit-h">
              <h2 id="edit-h">Phone and mailing address</h2>
              <p>How the club reaches you</p>
              <DetailsForm initial={view.form} />
            </section>
          ) : (
            <section className="box" aria-labelledby="later-h">
              <h2 id="later-h">Phone and mailing address</h2>
              <p>How the club reaches you</p>
              <p className="offline-note" role="status">We can&apos;t reach the club&apos;s books right now, so your details can&apos;t be changed here just yet. Please try again in a little while.</p>
              <div className="box-foot"><a className="btn btn-line" href="/family">Back to Family</a></div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
