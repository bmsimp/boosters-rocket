import { DisplaySettings } from "./display-settings";
import { SignOutButton } from "../../components/sign-out-button";

export const metadata = { title: "Display" };

export default function DisplayPage() {
  return (
    <main className="wrap single">
      <h1 className="page-title">Display</h1>
      <p className="lede">Make the portal easier to see and read. Changes apply right away.</p>
      <DisplaySettings />
      <section className="box" aria-labelledby="signout-h">
        <h2 id="signout-h">Signing out</h2>
        <p>On a shared or borrowed device, sign out when you&apos;re done.</p>
        <SignOutButton door="parent" />
      </section>
    </main>
  );
}
