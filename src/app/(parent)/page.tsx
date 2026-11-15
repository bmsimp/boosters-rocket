import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { firstName } from "@/lib/parents/first-name";
import { getClubSettings } from "@/lib/settings/club";
import { DetailsBox, NotSetUpBox, RosterAsOf, StudentsBox } from "./family-boxes";

export const metadata = { title: "Home" };

/**
 * Home. The head, then boxes in the order a phone shows them. The money box goes first among the boxes, as
 * `<section className="box money">`: the styles for `.home` then put it on the left at 760px and wider, with the
 * students and details on the right. Until it is there, the boxes fill both columns.
 */
export default async function ParentHome() {
  const ctx = await requireParentPage();
  const [family, club] = await Promise.all([loadMyFamily(ctx), getClubSettings()]);
  const first = firstName(ctx.name);
  return (
    <main className="wrap home">
      <div className="home-head">
        {family && <p className="family-name">{family.name}</p>}
        <h1 className="page-title">{first ? `Hi, ${first}` : "Hi"}</h1>
      </div>
      {family ? (
        <>
          {family.students && <StudentsBox students={family.students} />}
          <DetailsBox who={family.me ?? { name: ctx.name, email: ctx.email, phone: null }} treasurerEmail={club.treasurerEmail} />
          <RosterAsOf family={family} />
        </>
      ) : <NotSetUpBox treasurerEmail={club.treasurerEmail} />}
    </main>
  );
}
