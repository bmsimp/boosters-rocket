import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { firstName } from "@/lib/parents/first-name";
import { getClubSettings } from "@/lib/settings/club";
import { DetailsBox, NotSetUpBox, RosterAsOf, StudentsBox } from "./family-boxes";
import { MoneyBox } from "./money-box";

export const metadata = { title: "Home" };

/**
 * Home. The greeting, then boxes in the order a phone shows them: what the family owes first, then its students and
 * the parent's own details. The money box is headed with the family's name, as in design/reference/parent-home.html.
 * At 760px and wider the styles for `.home` put it on the left, with the students and details on the right.
 *
 * Home is where everyone lands after signing in, so its guard carries no return address.
 */
export default async function ParentHome() {
  const ctx = await requireParentPage();
  const [family, club] = await Promise.all([loadMyFamily(ctx), getClubSettings()]);
  const first = firstName(ctx.name);
  return (
    <main className="wrap home">
      <div className="home-head">
        <h1 className="page-title">{first ? `Hi, ${first}` : "Hi"}</h1>
      </div>
      {family ? (
        <>
          {/* Only for a family the roster may show: when it may not, nothing of it is shown, money included. */}
          <MoneyBox ctx={ctx} />
          {family.students && <StudentsBox students={family.students} />}
          <DetailsBox who={family.me ?? { name: ctx.name, email: ctx.email, phone: null }} treasurerEmail={club.treasurerEmail} />
          <RosterAsOf family={family} />
        </>
      ) : <NotSetUpBox treasurerEmail={club.treasurerEmail} />}
    </main>
  );
}
