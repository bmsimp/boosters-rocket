import type { ReactNode } from "react";
import { Card, PageHeader, StatusBadge } from "@/app/components/ui";
import type { HealthLine } from "@/lib/health/report";
import { HealthLineBody } from "./health/health-line";
import { IntegrationLogo } from "./integration-logo";
import type { IntegrationRowKey, Status } from "./statuses";

/**
 * The head of an integration's own page, the same on each (the Settings spec, "Integration pages"): the way back to
 * Integrations, the system's mark beside its name, one quiet line, and its status as a badge. A page for more than one
 * vendor (Staff sign-in: Microsoft and Google) has no mark: each card names its own.
 */
export function IntegrationHead({ of, title, lede, status }: { of?: IntegrationRowKey; title: string; lede: ReactNode; status: Status }) {
  return (
    <PageHeader back={{ href: "/staff/settings/integrations", label: "Integrations" }} className="integration-head"
      title={of ? <><IntegrationLogo of={of} size="head" />{title}</> : title} lede={lede}
      actions={<StatusBadge tone={status.tone}>{status.words}</StatusBadge>} />
  );
}

/**
 * The system's line of the Health page, where it can be acted on: the same words, times and fix. Shown to someone who
 * may read Health (every integration page is an Admin's, and so is Health), without a fix that leads back to this page.
 */
export function IntegrationHealth({ line, id, here }: { line: HealthLine | undefined; id: string; here: string }) {
  if (!line) return null;
  // Its fix leads here when this is the page to fix it on: left out, as the page is already open.
  const shown = line.fix?.href === here ? { ...line, fix: null } : line;
  return (
    <Card title="Health" titleId={`${id}-health-h`} description="The same line as on the Health page.">
      <HealthLineBody line={shown} />
    </Card>
  );
}
