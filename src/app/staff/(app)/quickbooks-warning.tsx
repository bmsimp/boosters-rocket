import { quickbooksProblems } from "@/lib/quickbooks/health";
import { Notice } from "@/app/components/notice";
import { LinkButton } from "@/app/components/ui";

/** Shown to Admins on the staff home while QuickBooks needs attention (spec §5 The staff warning). */
export async function QuickBooksWarning() {
  const problems = await quickbooksProblems();
  if (!problems.length) return null;
  return (
    <Notice tone="warning" title="QuickBooks needs attention" titleId="qbo-warn-h">
      <ul className="notice-list">{problems.map((p) => <li key={p.kind}>{p.text}{p.fix && <> <a href={p.fix.href}>{p.fix.label}</a></>}</li>)}</ul>
      <p className="box-foot"><LinkButton plain variant="secondary" href="/staff/settings/quickbooks">Open QuickBooks settings</LinkButton></p>
    </Notice>
  );
}
