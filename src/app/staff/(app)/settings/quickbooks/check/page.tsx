import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { LocalTime } from "@/app/components/local-time";
import { StateWords } from "@/app/components/state-words";
import { requireStaffPage } from "@/lib/guards";
import type { CheckResult } from "@/lib/db/schema";
import { codeWords, EXPECTATIONS, expectation, notRunWords, OUTCOME_WORDS, stopWords } from "@/lib/quickbooks/sandbox-check/expectations";
import { checkPageView, NOT_READY_WORDS, type RunView } from "@/lib/quickbooks/sandbox-check/view";
import { BackToSettings } from "../../back-to-settings";
import { runCheckAction } from "./actions";
import { RunCheckButton } from "./run-button";

export const metadata = { title: "Check the portal's requests" };
export const dynamic = "force-dynamic";

const STATE = { as_expected: "done", learned: "done", not_as_expected: "todo", not_run: "waived" } as const;
const AGAINST = (r: Pick<RunView, "environment" | "writes">) => (r.environment === "production" ? "The club's real books (reads only)" : r.writes ? "An Intuit sandbox company (reads and changes)" : "An Intuit sandbox company (reads only)");
const RESULT_WORDS: Record<NonNullable<RunView["outcome"]>, string> = {
  passed: "Every request answered as the portal expects", not_as_expected: "Some requests didn't answer as the portal expects", stopped: "Stopped before it finished", cut_off: "Cut off before it finished",
};

/** What one request found, in words: what was learned, or why it wasn't tried, and what an unexpected answer means. */
function Found({ r }: { r: CheckResult }) {
  const x = expectation(r.key);
  if (!x) return null;
  if (r.outcome === "not_run") return <>{notRunWords(r.code)}</>;
  const learned = Object.keys(r.learned).length ? x.learned(r.learned) : `QuickBooks answered with ${codeWords(r.code)}.`;
  return (
    <>
      <p>{learned}</p>
      {r.outcome === "not_as_expected" && x.ifNot && <p>{x.ifNot}{x.codeChange ? " This is a change to the portal for whoever maintains it; the check changes nothing by itself." : ""}</p>}
      {r.outcome === "not_as_expected" && x.codeChange && <p className="hint">For the maintainer: {x.where}.</p>}
    </>
  );
}

function Results({ run, group, caption }: { run: RunView; group: "reads" | "writes"; caption: string }) {
  const rows = EXPECTATIONS.filter((x) => x.group === group).map((x) => ({ x, r: run.results.find((r) => r.key === x.key) ?? { key: x.key, outcome: "not_run" as const, code: "stopped", learned: {} } }));
  return (
    <DataTable caption={caption} rowKey={(row) => row.x.key} rows={rows} columns={[
      { key: "request", header: "Request", rowHeader: true, cell: (row) => row.x.title },
      { key: "expects", header: "What the portal expects", cell: (row) => row.x.expects },
      { key: "result", header: "Result", cell: (row) => <StateWords state={STATE[row.r.outcome]} words={OUTCOME_WORDS[row.r.outcome]} /> },
      { key: "found", header: "What it found", cell: (row) => <Found r={row.r} /> },
    ]} />
  );
}

/**
 * Check the portal's requests (Admin only): one button that sends QuickBooks every request the portal makes and says,
 * for each, whether QuickBooks answered as the portal expects and what it learned. A step page of the QuickBooks
 * settings section. QuickBooks text is never shown here: the results hold codes, counts and host names, and the
 * check's own record names.
 */
export default async function CheckRequestsPage() {
  await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const view = await checkPageView();
  const latest = view.latest;
  return (
    <main className="wrap single">
      <BackToSettings />
      <h1 className="page-title">Check the portal&apos;s requests</h1>
      <p className="lede">The portal&apos;s requests to QuickBooks were written from Intuit&apos;s documentation. This check sends each of them to the connected company and says whether QuickBooks answered as the portal expects, and what it learned. It shows no family&apos;s name, amount or address: only counts, codes and the names of web addresses.</p>

      <section className="box" aria-labelledby="check-what-h"><h2 id="check-what-h">What it does</h2>
        {view.environment === "production"
          ? <Notice tone="info" live="none">This is the club&apos;s real books, so the check only reads. The requests that change things are off: they would make test families and an invoice in the real books. To check those, connect an Intuit sandbox company and run it there.</Notice>
          : <p>It reads the customer types, the customers, the products and services and some invoices. Then, in this Intuit sandbox company only, it makes two test families, a student and a parent, all named &ldquo;Booster Rocket check&rdquo; with the date, and email addresses at example.com, which can receive no mail. It changes only those: their phone, address, email and name, moves the student, makes a $1.00 invoice on the student and voids it. At the end it makes every one of them inactive. QuickBooks deletes no customer, so they stay in the sandbox, inactive.</p>}
        <p>It takes a minute or two. Nothing it finds changes how the portal works: where a request answers differently, the result says so, and that is a change for whoever maintains the portal.</p>
      </section>

      {view.open.length > 0 && (
        <Notice tone="warning" title="Left from a check that didn't finish" titleId="check-open-h">
          <p>These test records are still active in the connected company. The next run makes them inactive first.</p>
          <ul className="notice-list">{view.open.map((o) => <li key={o.id}>{o.name}{o.lastCode ? ` (the last try answered ${codeWords(o.lastCode)})` : ""}</li>)}</ul>
        </Notice>
      )}

      <section className="box" aria-labelledby="check-run-h"><h2 id="check-run-h">Run the check</h2>
        {view.readiness.ok ? <RunCheckButton run={runCheckAction} /> : <Notice tone="warning" live="none">{NOT_READY_WORDS[view.readiness.reason]}</Notice>}
      </section>

      {latest && (
        <section className="box" aria-labelledby="check-last-h"><h2 id="check-last-h">The last check</h2>
          <dl className="details">
            <dt>When</dt><dd><LocalTime iso={latest.startedAt} /></dd>
            <dt>By</dt><dd>{latest.startedBy ?? "Unknown"}</dd>
            <dt>Against</dt><dd>{AGAINST(latest)}{latest.thisCompany ? "" : ", not the company connected now"}</dd>
            <dt>Result</dt><dd>{latest.outcome === null ? "Still running" : RESULT_WORDS[latest.outcome]}</dd>
          </dl>
          {(latest.outcome === "stopped" || latest.outcome === "cut_off") && <Notice tone="warning" live="none">{stopWords(latest.stopCode)}</Notice>}
          <h3 className="table-head">Reading</h3>
          <Results run={latest} group="reads" caption="What the portal reads from QuickBooks" />
          <h3 className="table-head">Changing (sandbox only)</h3>
          <Results run={latest} group="writes" caption="What the portal changes in QuickBooks" />
        </section>
      )}

      {view.earlier.length > 0 && (
        <section className="box" aria-labelledby="check-earlier-h"><h2 id="check-earlier-h">Earlier checks</h2>
          <DataTable caption="Earlier checks" captionHidden rowKey={(r) => r.id} rows={view.earlier} columns={[
            { key: "when", header: "When", rowHeader: true, sorted: "descending", cell: (r) => <LocalTime iso={r.startedAt} /> },
            { key: "by", header: "By", cell: (r) => r.startedBy ?? "Unknown" },
            { key: "against", header: "Against", cell: (r) => `${AGAINST(r)}${r.thisCompany ? "" : ", another company"}` },
            { key: "result", header: "Result", cell: (r) => (r.outcome === null ? "Still running" : RESULT_WORDS[r.outcome]) },
          ]} />
        </section>
      )}
    </main>
  );
}
