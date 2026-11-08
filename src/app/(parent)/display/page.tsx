import { DisplaySettings } from "./display-settings";

export const metadata = { title: "Display" };

export default function DisplayPage() {
  return (
    <main className="wrap single">
      <h1 className="page-title">Display</h1>
      <p className="lede">Make the portal easier to see and read. Changes apply right away.</p>
      <DisplaySettings />
    </main>
  );
}
