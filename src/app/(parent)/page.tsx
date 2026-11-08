import { requireParentPage } from "@/lib/guards";

export default async function ParentHome() {
  const ctx = await requireParentPage();
  return (
    <main className="wrap single">
      <h1 className="page-title">Hi, {ctx.name.split(" ")[0]}</h1>
      <section className="box" aria-labelledby="soon-h">
        <h2 id="soon-h">Your family</h2>
        <p>Your students, what&apos;s owed and this season&apos;s forms will show here once the boosters connect QuickBooks.</p>
      </section>
    </main>
  );
}
