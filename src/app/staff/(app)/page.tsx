import { requireStaffPage } from "@/lib/guards";

export default async function StaffHome() {
  const ctx = await requireStaffPage();
  return (
    <main className="wrap single">
      <h1 className="page-title">Hi, {ctx.name.split(/[ @]/)[0]}</h1>
      <section className="box" aria-labelledby="next-h"><h2 id="next-h">What&apos;s here so far</h2>
        <p>{ctx.effective.isAdmin ? "You're an admin. Start by setting the club's name and colour, then add the rest of the board under Staff." : "Use the menu above for the parts you have access to."}</p>
      </section>
    </main>
  );
}
