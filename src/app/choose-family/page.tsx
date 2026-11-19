import { redirect } from "next/navigation";
import { getParentState } from "@/lib/auth/identity";
import { getClubSettings } from "@/lib/settings/club";
import { myFamilyNames } from "@/lib/parents/my-family-names";
import { RETURN_PARAM, safeReturnPath, withReturnPath } from "@/lib/auth/return-path";
import { SignOutButton } from "@/app/components/sign-out-button";
import { chooseFamilyAction } from "./actions";

export const metadata = { title: "Choose a family" };
export const dynamic = "force-dynamic";

type Query = Record<string, string | string[] | undefined>;

export default async function ChooseFamily({ searchParams }: { searchParams?: Promise<Query> } = {}) {
  const [state, club, query] = await Promise.all([getParentState(), getClubSettings(), searchParams]);
  // The page the parent asked for, carried here from the sign-in page or from that page's own guard. Checked here, and
  // again by the action when a family is chosen.
  const next = safeReturnPath(query?.[RETURN_PARAM]);
  if (state.status === "none") redirect(withReturnPath("/sign-in", next));
  const families = state.status === "ok" ? state.identity.families : state.families;
  const parentId = state.status === "ok" ? state.identity.parentId : state.parentId;
  const current = state.status === "ok" ? state.identity.guardianId : null;
  // Each family is named from the app's own record and chosen by the person's own guardian row: no QuickBooks id is
  // sent to the browser, neither as a label nor as the form's bound argument.
  const names = await myFamilyNames(parentId, families.map((f) => f.guardianId));
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name}</h1>
      <p className="lede">{families.length > 1 ? "You're a guardian in more than one family. Choose the one to look at; you can switch later." : "Choose the family to look at."}</p>
      <ul className="stack">
        {families.map((f) => (
          <li key={f.guardianId}>
            {/* Both arguments are bound, always: a form adds its FormData after them, and it must never arrive as `next`. */}
            <form action={chooseFamilyAction.bind(null, f.guardianId, next ?? undefined)}>
              <button className="btn" aria-current={f.guardianId === current ? "true" : undefined}>{names.get(f.guardianId)}</button>
            </form>
          </li>
        ))}
      </ul>
      <SignOutButton door="parent" />
    </main>
  );
}
