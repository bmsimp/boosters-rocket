import { requireStaffPage } from "@/lib/guards";
import { PortalAddress } from "@/app/components/portal-address";
import { Notice } from "@/app/components/notice";
import { SettingsHeader } from "../back-to-settings";
import { HealthLineWords, StateWord } from "./health-line";
import { healthLines } from "../statuses";
import { SupportLine } from "../../support-line";

export const metadata = { title: "Health" };
export const dynamic = "force-dynamic";

/**
 * Whether each part of the portal is working, in plain words, with when it last worked (v1 spec §14). Admin only. It is
 * the page to open after an update or a restore. It shows no family's data, so opening it is not audited.
 */
export default async function HealthPage() {
  const ctx = await requireStaffPage("Admin.Health.Read");
  const lines = await healthLines();
  const attention = lines.filter((l) => l.state === "attention").length;
  return (
    <main className="wrap single">
      <SettingsHeader effective={ctx.effective} title="Health" lede={<>Whether each part of the portal is working, and when it last worked. Look here after an update or a restore. Only Admins see this page.</>} />
      <Notice tone={attention === 0 ? "done" : "warning"}>{attention === 0 ? "Everything that is set up is working." : attention === 1 ? "1 thing needs attention." : `${attention} things need attention.`}</Notice>

      <section className="box" aria-labelledby="health-h"><h2 id="health-h">The portal</h2>
        <ul className="lines">{lines.map((l) => (
          <li key={l.key} data-health={l.key} data-state={l.state}><div>
            <span className="what"><b>{l.title}</b></span>
            <HealthLineWords line={l} />
          </div>
          <StateWord state={l.state} word={l.word} /></li>))}
        </ul>
      </section>

      <section className="box" aria-labelledby="health-address-h"><h2 id="health-address-h">The portal&apos;s address</h2>
        <PortalAddress />
      </section>
      <SupportLine />
    </main>
  );
}
