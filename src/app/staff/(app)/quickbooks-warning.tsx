import { quickbooksProblems } from "@/lib/quickbooks/health";

/** Shown to Admins on the staff home while QuickBooks needs attention (spec §5 The staff warning). */
export async function QuickBooksWarning() {
  const problems = await quickbooksProblems();
  if (!problems.length) return null;
  return (
    <section className="box" role="status" aria-labelledby="qbo-warn-h"><h2 id="qbo-warn-h">QuickBooks needs attention</h2>
      <ul>{problems.map((p) => <li key={p.kind}>{p.text}</li>)}</ul>
      <p className="box-foot"><a className="btn btn-line" href="/staff/settings/quickbooks">Open QuickBooks settings</a></p>
    </section>
  );
}
