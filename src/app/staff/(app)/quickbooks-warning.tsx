import { quickbooksProblems } from "@/lib/quickbooks/health";
import { Notice } from "@/app/components/notice";

/** Shown to Admins on the staff home while QuickBooks needs attention (spec §5 The staff warning). */
export async function QuickBooksWarning() {
  const problems = await quickbooksProblems();
  if (!problems.length) return null;
  return (
    <Notice tone="warning" title="QuickBooks needs attention" titleId="qbo-warn-h">
      <ul className="notice-list">{problems.map((p) => <li key={p.kind}>{p.text}</li>)}</ul>
      <p className="box-foot"><a className="btn btn-line" href="/staff/settings/quickbooks">Open QuickBooks settings</a></p>
    </Notice>
  );
}
