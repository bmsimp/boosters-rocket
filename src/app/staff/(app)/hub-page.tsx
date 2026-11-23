import { redirect } from "next/navigation";
import type { Effective } from "@/lib/permissions/effective";
import { List, ListRow, PageHeader } from "@/app/components/ui";
import { groupLinks } from "./staff-menu";

/** What each page of a hub is for, in one line under its name. */
const ABOUT: Record<string, string> = {
  "/staff/roster": "Every family and member, their students and guardians, and what can be changed.",
  "/staff/parents": "Everyone who can sign in, or once could, and their families.",
  "/staff/links": "Which family is which customer in the books, and what differs between them.",
  "/staff/messages": "News posted to every family, read in the portal.",
  "/staff/seasons": "The season's steps and what each asks of families.",
  "/staff/seasons/progress": "Where each family stands, and the ticks staff make.",
  "/staff/forms": "Who has signed each form, and the evidence.",
  "/staff/volunteer": "Events, shifts and who signed up.",
  "/staff/volunteer/credit": "Each family's volunteer credit, and credit added by the club.",
  "/staff/balances": "What each family owes, from the books.",
  "/staff/reconciliation": "Changes waiting to reach the books, and what needs a look.",
};

/**
 * A group's hub (the phone's tab bar opens it): its pages the person may open, each a row that leads to it, built from
 * the same menu as the bar (groupLinks()). It reads nothing but the person's permissions, so it is not audited, and
 * shows nothing they couldn't reach from the menu; someone with no page in the group is refused, as the menu would not
 * offer it.
 */
export function HubPage({ effective, label, lede }: { effective: Effective; label: string; lede: string }) {
  const links = groupLinks(effective, label);
  if (links.length === 0) redirect("/refused");
  return (
    <main className="wrap single hub-page">
      <PageHeader title={label} lede={lede} />
      <List label={label}>
        {links.map((l) => <ListRow key={l.href} href={l.href} title={l.label} meta={ABOUT[l.href]} />)}
      </List>
    </main>
  );
}
