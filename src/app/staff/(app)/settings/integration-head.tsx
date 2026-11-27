import type { ReactNode } from "react";
import { LinkButton, Notice, PageHeader, StatusDot } from "@/app/components/ui";
import type { HealthLine } from "@/lib/health/report";
import { IntegrationLogo } from "./integration-logo";
import type { IntegrationRowKey, Status } from "./statuses";

/**
 * The head of an integration's own page, the same on each (the Settings spec, "Integration pages"): the way back to
 * Integrations, the system's mark beside its name, one quiet line, and its status, drawn as the rail and the
 * Integrations rows draw it (StatusDot), so each state has one mark. A page for more than one vendor (Staff sign-in:
 * Microsoft and Google) has no mark: each card names its own. The page below doesn't say the status again.
 */
export function IntegrationHead({ of, title, lede, status }: { of?: IntegrationRowKey; title: string; lede: ReactNode; status: Status }) {
  return (
    <PageHeader back={{ href: "/staff/settings/integrations", label: "Integrations" }} className="integration-head"
      title={of ? <><IntegrationLogo of={of} size="head" />{title}</> : title} lede={lede}
      actions={<StatusDot tone={status.tone} words={status.words} />} />
  );
}

/**
 * The system's Health line, where it can be acted on: only when it needs attention, as a Notice with its state and its
 * fix (the Health page holds the rest of its words), and nothing while it works or is off. A fix that leads back to
 * this page is left out, as the page is already open.
 */
export function IntegrationHealth({ line, here }: { line: HealthLine | undefined; here: string }) {
  if (!line || line.state !== "attention") return null;
  const fix = line.fix && line.fix.href !== here ? line.fix : null;
  return (
    <Notice tone="warning" live="none">
      Health says {line.word.toLowerCase()}.{fix ? <> <LinkButton plain variant="tonal" size="sm" href={fix.href}>{fix.label}</LinkButton></> : null} Its full line is on the <a href="/staff/settings/health">Health</a> page.
    </Notice>
  );
}
