import Link from "next/link";
import { queueCounts } from "@/lib/roster/queue";
import { formsToChase, shiftsToFill, SOON_DAYS } from "@/lib/staff-home/today";
import { StateWords } from "@/app/components/state-words";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Item = { key: string; words: string; detail: string; href: string; link: string };

/**
 * What needs doing today on the staff home (staff home, DESIGN.md): one line for each thing waiting, as a count in words
 * with the way to it. Each kind is read only for staff who hold its permission, and only counts are read. With nothing
 * waiting the box says so in one calm line.
 */
export async function TodayBox({ writes, forms, shifts }: { writes: boolean; forms: boolean; shifts: boolean }) {
  const [queue, chase, fill] = await Promise.all([
    writes ? queueCounts() : null,
    forms ? formsToChase() : null,
    shifts ? shiftsToFill() : null,
  ]);
  const items: Item[] = [];
  if (queue && queue.stuck > 0) items.push({ key: "stuck", words: count(queue.stuck, "change stuck on its way to QuickBooks", "changes stuck on their way to QuickBooks"),
    detail: "The worker won't try again until someone asks, or gives up and makes the change in QuickBooks.", href: "/staff/reconciliation", link: "Open Reconciliation" });
  // A change saved in the portal first that didn't go through (stage 3's slice 9e): kept, never tried again by itself.
  if (queue && queue.refused > 0) items.push({ key: "refused", words: count(queue.refused, "change kept in the portal that QuickBooks didn't take", "changes kept in the portal that QuickBooks didn't take"),
    detail: "Each waits for someone to send the portal's value again or give it up.", href: "/staff/reconciliation", link: "Open Reconciliation" });
  if (queue && queue.waiting > 0) items.push({ key: "waiting", words: count(queue.waiting, "change waiting to reach QuickBooks", "changes waiting to reach QuickBooks"),
    detail: "The worker tries again by itself, at longer and longer gaps.", href: "/staff/reconciliation", link: "Open Reconciliation" });
  if (chase && chase.dueSoon.forms > 0) items.push({ key: "due", words: `${count(chase.dueSoon.unsigned, "form", "forms")} still to sign, due within ${SOON_DAYS} days or already due`,
    detail: `${chase.dueSoon.forms === 1 ? "One of this season's forms" : `${chase.dueSoon.forms} of this season's forms`}. "Remind now" emails the guardians who haven't signed.`, href: "/staff/forms", link: "Open Signed forms" });
  if (chase && chase.sealingLate > 0) items.push({ key: "sealing", words: `${count(chase.sealingLate, "form", "forms")} signed but not yet finished by Documenso`,
    detail: "Everyone signed more than an hour ago. Documenso seals the signed copy; when it doesn't, the Health page says what to check.", href: "/staff/forms", link: "Open Signed forms" });
  if (chase && chase.evidenceLate > 0) items.push({ key: "evidence", words: `${count(chase.evidenceLate, "signed form", "signed forms")} waiting for the signed copy to be kept`,
    detail: "Finished more than an hour ago. The worker fetches each from Documenso a few at a time.", href: "/staff/forms", link: "Open Signed forms" });
  if (fill && fill.shifts > 0) items.push({ key: "shifts", words: `${count(fill.places, "place", "places")} to fill on ${count(fill.shifts, "shift", "shifts")} in the next ${SOON_DAYS} days`,
    detail: "Families see how many places are left; nobody is told who signed up.", href: "/staff/volunteer", link: "Open Volunteering" });

  return (
    <section className="box" aria-labelledby="today-h"><h2 id="today-h">Today</h2>
      {items.length === 0 ? <StateWords state="done" words="Nothing needs doing today." /> : (
        <ul className="today">{items.map((i) => (
          <li key={i.key} data-today={i.key}>
            <div><StateWords state="todo" words={i.words} /><span className="when">{i.detail}</span></div>
            <Link href={i.href}>{i.link}</Link>
          </li>))}</ul>
      )}
    </section>
  );
}
