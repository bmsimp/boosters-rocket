import { redirect } from "next/navigation";
import { getParentState } from "@/lib/auth/identity";
import { getClubSettings } from "@/lib/settings/club";
import { familyLabel } from "@/app/components/family-label";
import { SignOutButton } from "@/app/components/sign-out-button";
import { chooseFamilyAction } from "./actions";

export const metadata = { title: "Choose a family" };
export const dynamic = "force-dynamic";

export default async function ChooseFamily() {
  const [state, club] = await Promise.all([getParentState(), getClubSettings()]);
  if (state.status === "none") redirect("/sign-in");
  const families = state.status === "ok" ? state.identity.families : state.families;
  const current = state.status === "ok" ? state.identity.familyQboId : null;
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name}</h1>
      <p className="lede">You&apos;re a guardian in more than one family. Choose the one to look at; you can switch later.</p>
      <ul className="stack">
        {families.map((f) => (
          <li key={f.guardianId}>
            <form action={chooseFamilyAction.bind(null, f.familyQboId)}>
              <button className="btn" aria-current={f.familyQboId === current ? "true" : undefined}>{familyLabel(f.familyQboId)}</button>
            </form>
          </li>
        ))}
      </ul>
      <SignOutButton door="parent" />
    </main>
  );
}
