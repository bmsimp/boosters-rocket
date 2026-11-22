import type { ReactNode } from "react";
import { formatMoney } from "@/lib/money/cents";
import { contrastRatio } from "@/lib/theme/contrast";
import { MARK_PAIRS, PALETTE, TEXT_PAIRS, type Mode, type Token } from "@/lib/theme/palette";
import {
  ActionOutcome, Avatar, Badge, Button, CalendarDate, Card, Checkbox, DataTable, EmptyState, KeyValue, LinkButton, List, ListRow, ListSubRow, ListTotal, LocalTime,
  Notice, PageHeader, SectionLabel, Select, Stat, StateWords, StatusBadge, StatusIcon, StepIndicator, TextArea, TextInput, Toolbar, type Column,
} from "../../../components/ui";
import { ChoiceSample, TakenChoiceSample } from "./gallery-choice";

/**
 * The design system's living gallery: every primitive in every state, with what it is for and how to import it. Only
 * sample content ("Sample Family"): nothing here reads the database, so the page and its static twin
 * (design/system/gallery.html, scripts/design-gallery.tsx) draw the same thing.
 */

const MODES: { mode: Mode; label: string; theme: "light" | "dark"; contrast?: "more" }[] = [
  { mode: "light", label: "Light", theme: "light" },
  { mode: "dark", label: "Dark", theme: "dark" },
  { mode: "lightHc", label: "Light, high contrast", theme: "light", contrast: "more" },
  { mode: "darkHc", label: "Dark, high contrast", theme: "dark", contrast: "more" },
];

const SECTIONS = [
  ["tokens", "Tokens"], ["contrast", "Contrast"], ["button", "Button"], ["badge", "Badge"], ["card", "Card"], ["list", "List"],
  ["page-header", "PageHeader"], ["section-label", "SectionLabel"], ["empty-state", "EmptyState"], ["stat", "Stat"], ["fields", "Fields"],
  ["avatar", "Avatar"], ["step-indicator", "StepIndicator"], ["key-value", "KeyValue"], ["toolbar", "Toolbar"], ["data-table", "DataTable"],
  ["notice", "Notice"], ["state-words", "StateWords"], ["time-money", "Time and money"], ["frame", "Bar and tabs"], ["themes", "Display modes"],
] as const;

function Section({ id, name, use, importLine, children }: { id: string; name: string; use: ReactNode; importLine: string; children: ReactNode }) {
  return (
    <section className="ds-section" aria-labelledby={`ds-${id}`}>
      <h2 id={`ds-${id}`}>{name}</h2>
      <p className="ds-use">{use}</p>
      <code className="ds-import">{importLine}</code>
      {children}
    </section>
  );
}

const UI = (names: string) => `import { ${names} } from "@/app/components/ui";`;
const Arrow = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;

type Row = { pair: string; ratios: Record<Mode, number>; floor: "text" | "mark" };
const pairRows: Row[] = [
  ...TEXT_PAIRS.map(([fg, bg]) => ({ fg, bg, floor: "text" as const })),
  ...MARK_PAIRS.map(([fg, bg]) => ({ fg, bg, floor: "mark" as const })),
].map(({ fg, bg, floor }: { fg: Token; bg: Token; floor: "text" | "mark" }) => ({
  pair: `${fg} on ${bg}`, floor,
  ratios: Object.fromEntries(MODES.map(({ mode }) => [mode, contrastRatio(PALETTE[mode][fg], PALETTE[mode][bg])])) as Record<Mode, number>,
}));
function ratioCell(mode: Mode) {
  return function ratio(r: Row) {
    const floor = r.floor === "mark" ? 3 : mode.endsWith("Hc") ? 7 : 4.5;
    const v = r.ratios[mode];
    return <>{v.toFixed(2)}{v < floor && " (under its floor)"}</>;
  };
}
const contrastColumns: Column<Row>[] = [
  { key: "pair", header: "Pair", rowHeader: true, cell: (r) => <>{r.pair}<span className="when">{r.floor === "mark" ? "A mark: 3:1" : "Text: 4.5:1, 7:1 in high contrast"}</span></> },
  ...MODES.map(({ mode, label }) => ({ key: mode, header: label, numeric: true, cell: ratioCell(mode) })),
];

type Invoice = { id: string; what: string; due: string; cents: number; state: "Open" | "Paid" };
const INVOICES: Invoice[] = [
  { id: "1", what: "Sample uniform fee", due: "2026-11-15", cents: 8500, state: "Open" },
  { id: "2", what: "Sample trip deposit", due: "2026-11-22", cents: 10000, state: "Open" },
  { id: "3", what: "Sample band fee", due: "2026-09-01", cents: 15000, state: "Paid" },
];
const invoiceColumns: Column<Invoice>[] = [
  { key: "what", header: "Invoice", rowHeader: true, cell: (i) => i.what },
  { key: "due", header: "Due", cell: (i) => <CalendarDate iso={i.due} /> },
  { key: "state", header: "State", cell: (i) => <StatusBadge tone={i.state === "Paid" ? "done" : "due"}>{i.state}</StatusBadge> },
  { key: "amount", header: "Amount", numeric: true, sorted: "descending", cell: (i) => formatMoney(i.cents) },
  { key: "open", header: "Actions", quiet: true, cell: () => <LinkButton plain variant="secondary" size="sm" href="#ds-data-table">Open</LinkButton> },
];

const SWATCHES = ["ground", "surface", "surface-muted", "border", "border-control", "border-strong", "ink", "ink-2", "ink-3",
  "done", "done-soft", "due", "due-soft", "late", "late-soft", "neutral-soft"] as const;

/** A small piece of Home, drawn again in each display mode. */
function MiniHome({ id }: { id: string }) {
  return (
    <>
      <Card title="Sample Family" titleId={`${id}-h`}>
        <div className="owed"><div className="amt num">{formatMoney(18500)}</div><div className="asof">Owed now. From QuickBooks, as of 2:14 pm.</div></div>
      </Card>
      <div>
        <SectionLabel level={3}>To do</SectionLabel>
        <List>
          <ListRow status={{ tone: "due", words: "Due in 8 days" }} title="Sign the travel form" action={<LinkButton plain size="sm" href={`#${id}-h`}>Sign</LinkButton>} />
          <ListRow status={{ tone: "late", words: "Was due Oct 30" }} title="Sample trip deposit" amount={formatMoney(10000)} />
          <ListRow status={{ tone: "done", words: "Done" }} title="Sample uniform fitting" />
        </List>
      </div>
      <Notice tone="warning">A sample notice in this mode.</Notice>
    </>
  );
}

export function Gallery() {
  return (
    <>
      <PageHeader title="Design system" lede="Every component the portal's pages are built from, in every state, with when to use it and the line that imports it. Nothing on this page is real data." />
      <nav aria-label="Components">
        <ul className="ds-toc">{SECTIONS.map(([id, name]) => <li key={id}><a href={`#ds-${id}`}>{name}</a></li>)}</ul>
      </nav>

      <Section id="tokens" name="Tokens" use="The colors, type, spacing and corners every class is drawn with (src/app/booster.css, section 1). Use a token, never a hex color or a px font size. The club's color is an accent only: primary buttons, the current nav item, focus rings and the logo tile." importLine={`color: var(--ink-2); padding: var(--s3) var(--s4); border-radius: var(--radius);`}>
        <h3 className="table-head">Color roles</h3>
        <div className="ds-swatches">
          {SWATCHES.map((t) => <span key={t} className="ds-swatch" style={{ ["--swatch" as string]: `var(--${t})` }}><b>--{t}</b>{PALETTE.light[t]} / {PALETTE.dark[t]}</span>)}
          {(["club", "club-text", "club-tint"] as const).map((t) => <span key={t} className="ds-swatch" style={{ ["--swatch" as string]: `var(--${t})` }}><b>--{t}</b>The club&apos;s, set at runtime</span>)}
        </div>
        <h3 className="table-head">Type scale</h3>
        <div className="ds-type">
          <p className="t-2xl">--text-2xl 2rem: an amount ($185.00)</p>
          <p className="t-xl">--text-xl 1.5rem: a page title (1.75rem from 760px)</p>
          <p className="t-lg">--text-lg 1.125rem: a card&apos;s title</p>
          <p className="t-control">--text-control 0.9375rem: buttons, nav links, table cells, a card&apos;s quiet line</p>
          <p className="t-md">--text-md 1rem: body text, the least a phone ever reads</p>
          <p className="t-sm">--text-sm 0.875rem: a meta line, a label</p>
          <p className="t-xs">--text-xs 0.8125rem: table headers and badges, the floor</p>
        </div>
        <h3 className="table-head">Space and corners</h3>
        <p className="ds-note">Space: --s1 4px, --s2 8px, --s3 12px, --s4 16px, --s5 24px, --s6 32px, --s7 48px; the page gutter --cell is 16px on a phone and 24px from 760px. Corners: --radius 8px (cards, lists, notices, menus), --radius-control 6px (buttons, fields), --radius-badge 4px, --radius-round only for avatars and status dots. One shadow, --shadow-menu, on menus. Motion: --dur-fast 120ms and --dur 200ms, nothing at all with reduced motion.</p>
        <p className="ds-note">Focus: every ring is --ring (2px, 3px in high contrast) in --focus, the mode&apos;s own club text color. Weights: 400, 500, 600, and 700 only for the club logo tile.</p>
      </Section>

      <Section id="contrast" name="Contrast" use="Every text and ground pair the system draws, in every display mode, measured (src/lib/theme/palette.ts; tests/unit/design-tokens.test.ts fails when one falls under its floor). The club's color is derived per club to pass on every ground of its mode." importLine={`import { PALETTE, TEXT_PAIRS } from "@/lib/theme/palette";`}>
        <DataTable caption="Contrast ratios by display mode" columns={contrastColumns} rows={pairRows} rowKey={(r) => r.pair} />
      </Section>

      <Section id="button" name="Button and LinkButton" use="Button does something; LinkButton goes somewhere. One primary (the club's fill) per area; secondary for the others; quiet for a small action in a sentence or a row; danger for removing or ending. Every button is 44px tall. Busy is aria-disabled with a spinner, never disabled, on parent pages." importLine={UI("Button, LinkButton")}>
        <div className="ds-samples">
          <Button>Save my details</Button>
          <Button variant="secondary">Cancel</Button>
          <Button variant="quiet">Not now</Button>
          <Button variant="danger">Remove guardian</Button>
          <Button variant="club">Add a passkey</Button>
          <LinkButton plain href="#ds-button">Pay<Arrow /></LinkButton>
        </div>
        <div className="ds-samples">
          <Button className="ds-hover">Hover</Button>
          <Button variant="secondary" className="ds-hover">Hover</Button>
          <Button className="ds-focus">Focus</Button>
          <Button busy>Saving…</Button>
          <Button variant="secondary" disabled>Disabled</Button>
          <Button size="sm">Small</Button>
          <Button size="sm" variant="secondary">Small secondary</Button>
        </div>
        <p className="ds-note">Hover lays a light wash over the fill (secondary: the muted ground). Focus is the club&apos;s ring, 2px (3px in high contrast), drawn here on the sample. A long label wraps inside the button: <Button variant="secondary">See every payment the family has made this season</Button></p>
      </Section>

      <Section id="badge" name="Badge and StatusBadge" use="A short label on a tint (a role, a count), or a state with its icon and words. Never color alone: the words say it." importLine={UI("Badge, StatusBadge, StatusIcon")}>
        <div className="ds-samples">
          <StatusBadge tone="done">Paid</StatusBadge>
          <StatusBadge tone="due">2 to sign</StatusBadge>
          <StatusBadge tone="late">Overdue</StatusBadge>
          <StatusBadge tone="neutral">Waiting for QuickBooks</StatusBadge>
          <StatusBadge tone="neutral">Not started</StatusBadge>
          <Badge>Admin</Badge>
          <Badge tone="club">New</Badge>
        </div>
        <div className="ds-samples">
          {(["done", "due", "late", "neutral"] as const).map((t) => <span key={t} className="ds-tone"><StatusIcon tone={t} />StatusIcon {t}</span>)}
        </div>
      </Section>

      <Section id="card" name="Card" use="A titled region of a page: what a family owes, its students, a setting. Its title names the region for screen readers. Actions sit at the foot, or beside the title with headActions. Never a card inside a card." importLine={UI("Card")}>
        <div className="ds-pair">
          <Card title="Sample Family" titleId="ds-card-a" description="A quiet line under the title" actions={<LinkButton variant="secondary" plain href="#ds-card">See your payments</LinkButton>}>
            <p className="help">The card&apos;s content: words, a List, a DataTable or a form.</p>
          </Card>
          <Card title="A much longer title that has to wrap onto a second line on a phone" titleId="ds-card-b" headActions={<Button size="sm" variant="secondary">Edit</Button>}>
            <p className="help">With headActions the action sits beside the title and wraps under it when there is no room.</p>
          </Card>
        </div>
      </Section>

      <Section id="list" name="List and ListRow" use="The core of the look: a bordered list of like rows, each a status icon with its words, a title, a meta line, then an amount or a compact action. Use it for To do, Students, Payments and any short list a person acts on; ListTotal under a list of amounts sums them. A long list of records with columns is a DataTable." importLine={UI("List, ListRow, ListSubRow, ListTotal, SectionLabel")}>
        <div className="ds-samples stacked">
          <div>
            <SectionLabel level={3}>To do</SectionLabel>
            <List>
              <ListRow status={{ tone: "due", words: "2 of 3 left" }} title="Sign Sam's forms" meta="Due Nov 15" action={<LinkButton plain size="sm" href="#ds-list">Sign</LinkButton>} />
              <ListRow status={{ tone: "late", words: "Was due Oct 30" }} title="Sample trip deposit, Alex" amount={formatMoney(10000)} action={<LinkButton plain size="sm" href="#ds-list">Pay</LinkButton>} />
              <ListRow status={{ tone: "due", words: "Due Nov 22" }} title="Sample uniform fee with a long name that wraps onto a second line, Sam Sample" amount={formatMoney(8500)} action={<LinkButton plain size="sm" variant="secondary" href="#ds-list">Pay</LinkButton>} />
              <ListRow status={{ tone: "done", words: "All signed" }} title="Alex Sample" meta="Flute · Grade 10" />
              <ListRow status={{ tone: "neutral", words: "Not started" }} title="Volunteer shift" />
            </List>
          </div>
          <div>
            <SectionLabel level={3}>Students, each with its parts (ListSubRow)</SectionLabel>
            <List>
              <ListRow status={{ tone: "due", words: "1 thing left to do in Uniforms" }} title="Sam Sample" amount="1 of 2 done"
                sub={<>
                  <ListSubRow title="Uniform fitting attended" meta={<StateWords state="done" words="Done" />} />
                  <ListSubRow title="Sample travel form" meta={<StateWords state="todo" words="Not signed yet" />} />
                </>} />
              <ListRow status={{ tone: "done", words: "Done with Uniforms" }} title="Alex Sample" amount="1 of 1 done" />
            </List>
          </div>
          <Card title="Rows that add up (ListTotal)" titleId="ds-list-total" description="Payments: each amount comes after its Pay, in one column with the total.">
            <List>
              <ListRow className="invoice-row" status={{ tone: "late" }} title="Invoice QZ-1042" meta="Was due Oct 30" amount={formatMoney(10000)} />
              <ListRow className="invoice-row" status={{ tone: "due" }} title="Invoice QZ-1041, Sam Sample" meta={["Due Nov 15, in 8 days", "Invoice date Oct 1, 2026"]} amount={formatMoney(8500)}
                action={<LinkButton plain size="sm" href="#ds-list-total">Pay</LinkButton>} />
            </List>
            <ListTotal label="Total" amount={formatMoney(18500)} />
            <p className="help">Need more time? Ask the treasurer.</p>
          </Card>
          <div>
            <SectionLabel level={3}>A row with a detail under it, and a pair of actions</SectionLabel>
            <List>
              <ListRow title={<strong>Sample passkey</strong>} meta={["Added Oct 1, 2026", "Last used Nov 20, 2026"]}
                action={<><Button size="sm" variant="quiet">Rename</Button><Button size="sm" variant="danger">Remove</Button></>}
                detail={<p className="help">Removing your last passkey means we ask for the emailed code again.</p>} />
              <ListRow title="Pancake breakfast, Griddle" meta={["Saturday, 7:00 am to 9:00 am", "You're doing this one"]}
                detail={<><span className="state">Signed up</span><Button size="sm" variant="secondary">Cancel my sign-up</Button></>} />
            </List>
          </div>
          <div>
            <SectionLabel level={3}>Students (empty)</SectionLabel>
            <List><li className="list-row"><EmptyState title="No students yet">The club will add them. There&apos;s nothing you need to do.</EmptyState></li></List>
          </div>
        </div>
      </Section>

      <Section id="page-header" name="PageHeader" use="The top of every page: the way back when there is one, the h1, one quiet line, and the page's own actions." importLine={UI("PageHeader")}>
        <div className="ds-samples stacked">
          <PageHeader sample back={{ href: "#ds-page-header", label: "Back to Roster" }} title="Sample Family" lede="2 students · 1 guardian · as of 2:14 pm" actions={<><Button variant="secondary">Rename</Button><Button>Add a student</Button></>} />
        </div>
      </Section>

      <Section id="section-label" name="SectionLabel" use="The small heading over a List or a table on a page that has several (Home's To do, Students). A real heading, drawn quietly." importLine={UI("SectionLabel")}>
        <div className="ds-samples"><SectionLabel level={3}>Students</SectionLabel></div>
      </Section>

      <Section id="empty-state" name="EmptyState" use="Where a list or table has nothing yet: say what will be here, kindly, and the one action that fills it." importLine={UI("EmptyState")}>
        <EmptyState title="No volunteer events yet" action={<Button>Add an event</Button>}>When you add one, families see it on their Volunteer page.</EmptyState>
      </Section>

      <Section id="stat" name="Stat" use="One figure that matters on a staff page, with its label. Group a few in .stats. Not a hero number on a parent page: there the amount sits in its card." importLine={UI("Stat")}>
        <div className="stats">
          <Stat label="Owed by families" value={formatMoney(124050)} meta="38 open invoices" />
          <Stat label="Forms signed" value="112 of 140" meta="28 still to sign" />
          <Stat label="Volunteer hours" value="86" />
        </div>
      </Section>

      <Section id="fields" name="Fields" use="TextInput, TextArea, Select and Checkbox, each with its label, a hint and an error tied to the control with aria-describedby. ChoiceGroup for a few options that need explaining. The id comes from the page." importLine={UI("TextInput, TextArea, Select, Checkbox, ChoiceGroup")}>
        <div className="ds-pair">
          <div className="stack">
            <TextInput id="ds-name" label="Name" defaultValue="Alex Sample" autoComplete="off" />
            <TextInput id="ds-phone" label="Phone" type="tel" hint="The club calls this number about pickups." defaultValue="555-0100" autoComplete="off" />
            <TextInput id="ds-email" label="Email" type="email" defaultValue="alex@example" error="Enter an email address like name@example.com." autoComplete="off" />
            <TextInput id="ds-disabled" label="Family name" defaultValue="Sample Family" disabled hint="The club changes this for you." />
          </div>
          <div className="stack">
            <Select id="ds-season" label="Season" defaultValue="fall"><option value="fall">Sample fall season</option><option value="spring">Sample spring season</option></Select>
            <TextArea id="ds-note" label="Note for staff" hint="Only staff read this." defaultValue="A sample note." />
            <Checkbox id="ds-remind" label="Email me a reminder" hint="A day before it is due." defaultChecked />
            <Checkbox id="ds-optout" label="Skip this one" disabled />
          </div>
        </div>
        <ChoiceSample />
          <TakenChoiceSample />
      </Section>

      <Section id="avatar" name="Avatar" use="A person's initials beside their name. The club bar's account control is one, with a 44px tap target." importLine={UI("Avatar")}>
        <div className="ds-samples"><Avatar initials="AS" /><Avatar initials="SS" club /><Avatar initials="RS" size="sm" /><span className="account" aria-hidden="true">AS</span></div>
      </Section>

      <Section id="step-indicator" name="StepIndicator" use="Where something stands in a short sequence of steps: the season's steps on Home. Done steps are ticked, the current one is the club's color and named in words. Not a control." importLine={UI("StepIndicator")}>
        <p className="season-title">Sample season · <b>Step 2 of 4: Uniforms</b></p>
        <StepIndicator steps={[
          { key: "a", label: "Join", done: true, words: ", done" },
          { key: "b", label: "Uniforms", current: true, words: ", current step", marker: <span className="on-set" aria-hidden="true"><i className="done" title="Alex is done">A</i><i title="Sam has more to do">S</i></span> },
          { key: "c", label: "Trip", words: "" },
          { key: "d", label: "Banquet", words: "" },
        ]} />
      </Section>

      <Section id="key-value" name="KeyValue" use="A few facts about one thing, label beside value: a person's details, a setting as it stands. Leave out an item with no value." importLine={UI("KeyValue")}>
        <KeyValue items={[
          { key: "n", label: "Name", value: "Alex Sample" },
          { key: "e", label: "Email", value: "alex.sample.with.a.long.address@example.com" },
          { key: "p", label: "Phone", value: "555-0100", numeric: true },
        ]} />
      </Section>

      <Section id="toolbar" name="Toolbar" use="Filters over the table or list they scope, actions at the end. It wraps on a phone." importLine={UI("Toolbar, TextInput, Select")}>
        <Toolbar label="Filter invoices" end={<Button variant="secondary">Clear</Button>}>
          <TextInput id="ds-search" label="Search" type="search" placeholder="A name or invoice" autoComplete="off" />
          <Select id="ds-state" label="State" defaultValue="open"><option value="open">Open</option><option value="paid">Paid</option></Select>
        </Toolbar>
      </Section>

      <Section id="data-table" name="DataTable" use="Many records with the same columns: the roster, Balances, the audit log. Numbers right-aligned in tabular figures; a quiet column for row actions. On a phone each row stacks, label beside value." importLine={UI("DataTable, type Column")}>
        <DataTable caption="Sample invoices" columns={invoiceColumns} rows={INVOICES} rowKey={(i) => i.id} />
        <DataTable caption="Grouped by family" columns={invoiceColumns} groups={[{ key: "g", heading: "Sample Family", rows: INVOICES.slice(0, 2) }]} rowKey={(i) => `g${i.id}`} />
      </Section>

      <Section id="notice" name="Notice and ActionOutcome" use="A status that stands apart: information, needs attention, done, a problem. ActionOutcome shows what a server action answered. A problem is announced as an alert, the rest as a status. An answer that replaces the form that was pressed takes the focus: give it a ref (and Notice tabIndex={-1})." importLine={UI("Notice, ActionOutcome")}>
        <div className="ds-samples stacked">
          <Notice tone="info">The figures are from QuickBooks, as of 2:14 pm.</Notice>
          <Notice tone="warning">Two families have no sign-in yet.</Notice>
          <ActionOutcome state={{ ok: true, message: "Saved. The club's records are up to date." }} />
          <ActionOutcome state={{ ok: false, errors: ["Enter a phone number with 10 digits.", "Enter a mailing address."] }} />
          <Notice tone="warning" title="QuickBooks needs connecting again" titleId="ds-notice-title" live="none"><p>Payments are paused until it is. It takes a minute.</p><div className="box-foot"><Button size="sm">Connect QuickBooks</Button></div></Notice>
        </div>
      </Section>

      <Section id="state-words" name="StateWords" use="A state inside a row or a cell, as words with an icon: done, still to do, waived." importLine={UI("StateWords")}>
        <div className="ds-samples"><StateWords state="done" words="Done with Uniforms" /><StateWords state="todo" words="1 thing left to do" /><StateWords state="waived" words="Waived" /></div>
      </Section>

      <Section id="time-money" name="LocalTime, CalendarDate and formatMoney" use="An instant in the viewer's own time, a calendar date the same for everyone, and an amount in tabular figures. Never format these yourself." importLine={`import { LocalTime, CalendarDate } from "@/app/components/ui";  import { formatMoney } from "@/lib/money/cents";`}>
        <div className="ds-samples"><LocalTime iso="2026-11-21T19:14:00Z" /><CalendarDate iso="2026-11-22" /><span className="num">{formatMoney(18500)}</span></div>
      </Section>

      <Section id="frame" name="Club bar and tabs" use="The frame every page sits in (ClubBar, ParentTabs): a white top bar with the club's logo tile, its name, the menu and the account; on a parent's phone, the tabs at the foot. The current place is the club's color and weight, never the color alone. Drawn here as samples." importLine={`import { ClubBar } from "@/app/components/club-bar";`}>
        <div className="ds-frame">
          <div className="bar"><div className="wrap">
            <span className="monogram" aria-hidden="true">SB</span><span className="club">Sample Boosters</span>
            <nav className="top-nav ds-show" aria-label="Sample menu"><a href="#ds-frame" aria-current="page">Home</a><a href="#ds-frame">Forms</a><a href="#ds-frame">Payments</a></nav>
            <span className="account" aria-hidden="true">AS</span>
          </div></div>
          <nav className="tabs" aria-label="Sample tabs">
            <a href="#ds-frame" aria-current="page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z" /></svg>Home</a>
            <a href="#ds-frame"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 3h9l3 3v15H6z" /><path d="M9 13l2 2 4-4" /></svg>Forms</a>
            <a href="#ds-frame"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="6" width="18" height="12" /><path d="M3 10h18M7 15h3" /></svg>Payments</a>
          </nav>
        </div>
      </Section>

      <Section id="themes" name="Display modes" use="Light, dark and high contrast for each follow the device, or the person's choice on Display. A sample can be put in one with data-theme and data-contrast on its wrapper (and .theme-sample to paint its ground)." importLine={`<div className="theme-sample" data-theme="dark" data-contrast="more">…</div>`}>
        <div className="ds-pair">
          {MODES.map(({ mode, label, theme, contrast }) => (
            <div key={mode} className="theme-sample" data-theme={theme} data-contrast={contrast}>
              <p className="section-label">{label}</p>
              <MiniHome id={`ds-mode-${mode}`} />
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
