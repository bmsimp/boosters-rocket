import type { ReactNode } from "react";
import { formatMoney } from "@/lib/money/cents";
import { contrastRatio } from "@/lib/theme/contrast";
import { MARK_PAIRS, PALETTE, TEXT_PAIRS, type Mode, type Token } from "@/lib/theme/palette";
import {
  ActionOutcome, Avatar, Badge, Button, CalendarDate, Card, Checkbox, DataTable, EmptyState, KeyValue, LinkButton, List, ListRow, ListSubRow, ListTotal, LocalTime,
  Notice, PageHeader, SectionLabel, Select, Stat, StateWords, StatusBadge, StatusDot, StatusIcon, StepIndicator, TextArea, TextInput, Toolbar, type Column,
} from "@/app/components/ui";
import { IntegrationLogo } from "../integration-logo";
import { PoweredBy } from "@/app/components/powered-by";
import { ChoiceSample, TakenChoiceSample } from "./gallery-choice";
import { BulkSample, ConfirmSample, DrawerSample, StepsChoiceSample } from "./gallery-sheets";
import { SeedSample } from "./gallery-seed";
import { RichTextEditor } from "@/app/components/rich-text-editor";

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
  ["tokens", "Tokens"], ["scheme", "Club scheme"], ["contrast", "Contrast"], ["button", "Button"], ["badge", "Badge"], ["card", "Card"], ["list", "List"],
  ["page-header", "PageHeader"], ["section-label", "SectionLabel"], ["empty-state", "EmptyState"], ["drawer", "Drawer"], ["confirm-dialog", "ConfirmDialog"], ["steps-choice", "StepsChoice"], ["stat", "Stat"], ["fields", "Fields"], ["rich-text-editor", "RichTextEditor"],
  ["avatar", "Avatar"], ["step-indicator", "StepIndicator"], ["key-value", "KeyValue"], ["toolbar", "Toolbar"], ["data-table", "DataTable"],
  ["notice", "Notice"], ["state-words", "StateWords"], ["settings-rail", "Settings list pane"], ["time-money", "Time and money"], ["frame", "Bar, rail and tabs"], ["powered-by", "Powered by"], ["themes", "Display modes"],
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
  { key: "open", header: "Actions", quiet: true, cell: () => <LinkButton plain variant="tonal" size="sm" href="#ds-data-table">Open</LinkButton> },
];

const SWATCHES = ["ground", "surface", "card", "surface-container-lowest", "surface-container-low", "surface-container", "surface-container-high", "surface-container-highest",
  "on-surface", "on-surface-variant", "outline", "outline-variant",
  "done", "done-container", "due", "due-container", "late", "late-container", "info", "info-container", "neutral-container", "badge-ink"] as const;

const TYPE_ROLES = [
  ["display-s", "2.25rem, 600: a staff page's title from 840px"],
  ["headline-l", "2rem, 650: a page's title on a phone"],
  ["headline-m", "1.75rem, 650: a stat"],
  ["headline-s", "1.5rem, 600: a sheet's or dialog's title"],
  ["title-l", "1.375rem, 600: a card's title, the club's name"],
  ["title-m", "1rem, 600: a list row's title, a Medium button"],
  ["title-s", "0.875rem, 600: table headers, section labels, the rail's groups"],
  ["body-l", "1rem, 400: body text, the least a phone ever reads"],
  ["body-m", "0.875rem, 400: a meta line, a card's quiet line, table cells"],
  ["label-l", "0.875rem, 600: buttons, nav links, field labels"],
  ["label-m", "0.8125rem, 600: status labels and tab labels, the floor (M3's 12px, raised)"],
] as const;
const SHAPES = ["xs 4px: fields", "s 8px: status labels, a pressed button", "m 12px: the logo tile", "l 16px: notices, a side sheet's edge, choice tiles",
  "l-inc 20px: cards, a list's ends", "xl 28px: dialogs, the staff pane", "full: buttons, the tab pill, the bulk bar, avatars"] as const;

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

      <Section id="tokens" name="Tokens" use="Material 3 Expressive's tokens in src/app/booster.css, section 1: color roles, the type scale, the shape scale, elevation, motion and state layers. Use a token, never a hex color or a px font size. The surfaces, the text colors and the status colors are fixed, the same for every club; the club's color seeds the primary, secondary and tertiary roles (Club scheme, below)." importLine={`color: var(--on-surface-variant); padding: var(--s3) var(--s4); border-radius: var(--shape-l-inc); font: var(--title-m);`}>
        <h3 className="table-head">Fixed color roles (light / dark)</h3>
        <div className="ds-swatches">
          {SWATCHES.map((t) => <span key={t} className="ds-swatch" style={{ ["--swatch" as string]: `var(--${t})` }}><b>--{t}</b>{PALETTE.light[t]} / {PALETTE.dark[t]}</span>)}
        </div>
        <h3 className="table-head">The club&apos;s roles (made from its color at runtime)</h3>
        <div className="ds-swatches">
          {(["primary", "on-primary", "primary-container", "on-primary-container", "secondary", "on-secondary", "secondary-container", "on-secondary-container",
            "tertiary", "on-tertiary", "tertiary-container", "on-tertiary-container", "focus", "seed"] as const).map((t) => (
            <span key={t} className="ds-swatch" style={{ ["--swatch" as string]: `var(--${t})` }}><b>--{t}</b>{t === "seed" ? "The exact color: the logo tile alone" : t === "focus" ? "The ring: primary, or on-surface" : "The club's, in this mode"}</span>
          ))}
        </div>
        <h3 className="table-head">Type scale (M3, emphasized, in Inter)</h3>
        <div className="ds-type">
          {TYPE_ROLES.map(([role, words]) => <p key={role} style={{ font: `var(--${role})` }}>--{role} {words}</p>)}
        </div>
        <h3 className="table-head">Shape</h3>
        <div className="ds-shapes">
          {SHAPES.map((sh) => { const name = sh.split(/[ :]/)[0]!; return <span key={sh} className="ds-shape" style={{ ["--r" as string]: `var(--shape-${name})` }}><b>--shape-{name}</b>{sh.slice(name.length + 1).replace(/^: /, "")}</span>; })}
        </div>
        <h3 className="table-head">Space, elevation, motion and states</h3>
        <p className="ds-note">Space: --s1 4px, --s2 8px, --s3 12px, --s4 16px, --s5 24px, --s6 32px, --s7 48px (M3&apos;s 4px grid); the page gutter --cell is 16px compact and 24px from 600px. Breakpoints are M3&apos;s window classes: 600, 840 and 1200px.</p>
        <p className="ds-note">Elevation is tone first: a card is a surface container on the page, with no shadow. Only what floats has one, --shadow-3: the bulk bar, dialogs, side sheets and menus.</p>
        <div className="ds-samples"><span className="ds-float">--shadow-3: the floating bulk bar</span></div>
        <p className="ds-note">Motion: springs for what moves (a button&apos;s corner on press, sheets and the dialog coming in, the tab pill, the bulk bar), --spring-fast and --spring-default; color and opacity on --effects over 150ms, never bouncing. Text never moves. With reduced motion nothing moves at all.</p>
        <p className="ds-note">States: hover washes the content color over the container at 8% (--sl-hover), a press at 10% (--sl-press). Every control and lone link is at least --target, 48 by 48. Focus: every ring is --ring, 3px, in --focus (the club&apos;s primary, or on-surface where primary can&apos;t hold 3:1 off every surface), 2px clear of what it rings.</p>
      </Section>

      <Section id="scheme" name="Club scheme" use="How a club's color becomes its palette (src/lib/theme/scheme.ts, Google's material-color-utilities): primary keeps the color's own strength at M3's fixed tones, so its contrast is the same for every club; secondary is the same hue, quiet; tertiary is the hue turned about 60 degrees. Light, dark and both high-contrast modes are all made from it. Try a color: nothing is saved." importLine={`import { clubScheme, clubCssVars } from "@/lib/theme/scheme";`}>
        <SeedSample />
      </Section>
      <Section id="contrast" name="Contrast" use="Every text and ground pair the system draws, in every display mode, measured (src/lib/theme/palette.ts; tests/unit/design-tokens.test.ts fails when one falls under its floor). Each club's own roles are checked for twelve sample colors in tests/unit/design-tokens.test.ts." importLine={`import { PALETTE, TEXT_PAIRS } from "@/lib/theme/palette";`}>
        <DataTable caption="Contrast ratios by display mode" columns={contrastColumns} rows={pairRows} rowKey={(r) => r.pair} />
      </Section>

      <Section id="button" name="Button and LinkButton" use="Button does something; LinkButton goes somewhere. M3 Expressive's set: filled (the club's primary, one per area), tonal (a row's action, a second action), outlined (a secondary action standing alone), text (the least: Cancel, Clear, Not now), danger (removes or ends something, in the late color) and danger-filled (that action inside its ConfirmDialog). Fully round; the corner squares off a little while pressed. Small (sm, md) is drawn 40px tall inside a 48px target; lg is M3's medium, 56px, for a page's main button and sheet and dialog footers. Busy is aria-disabled with a spinner, never disabled, on parent pages." importLine={UI("Button, LinkButton")}>
        <div className="ds-samples">
          <Button>Save my details</Button>
          <Button variant="tonal">Add a passkey</Button>
          <Button variant="outlined">See your payments</Button>
          <Button variant="text">Not now</Button>
          <Button variant="danger">Remove guardian</Button>
          <Button variant="danger-filled">Remove this credit</Button>
          <LinkButton plain href="#ds-button">Pay<Arrow /></LinkButton>
        </div>
        <div className="ds-samples">
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Medium, 56px</Button>
          <Button size="lg" variant="tonal">Medium tonal</Button>
        </div>
        <div className="ds-samples">
          <Button className="ds-hover">Hover</Button>
          <Button variant="tonal" className="ds-hover">Hover</Button>
          <Button variant="outlined" className="ds-hover">Hover</Button>
          <Button className="ds-focus">Focus</Button>
          <Button busy>Saving…</Button>
          <Button variant="outlined" disabled>Disabled</Button>
        </div>
        <p className="ds-note">Hover washes the button&apos;s own ink over its fill at 8%, a press at 10%. Focus is the 3px ring, 2px clear of the fill, drawn here on the sample. A long label wraps inside the button: <Button variant="outlined">See every payment the family has made this season</Button></p>
        <div className="ds-pair">
          <div>
            <h3>Do: a button for anything that starts, changes or moves a task on</h3>
            <div className="ds-samples">
              <LinkButton plain href="#ds-button">Next: connect to QuickBooks</LinkButton>
              <LinkButton plain variant="outlined" href="#ds-button">Connect a different company</LinkButton>
            </div>
            <p className="ds-note">Button submits a form; LinkButton goes to an action or the next step. Filled for the one thing the step is for, tonal or outlined for the others.</p>
          </div>
          <div>
            <h3>Don&apos;t: an underlined link for an action or a step</h3>
            <p><a className="link-line" href="#ds-button">Skip to step 3</a> · <a className="link-line" href="#ds-button">Connect a different company</a></p>
            <p className="ds-note">A plain link is only for reading more, help, going back to where you came from (&ldquo;Back to Roster&rdquo;), or a record&apos;s own page in a list or table. Alone on its line it takes <code>.link-line</code>.</p>
          </div>
        </div>
      </Section>

      <Section id="badge" name="Badge and StatusBadge" use="A status label: a state's icon and words on its tone's container (StatusBadge), or a short label (a role, a count). 8px corners, never fully round, so it never looks like a button or a chip. Never color alone: the words say it." importLine={UI("Badge, StatusBadge, StatusIcon")}>
        <div className="ds-samples">
          <StatusBadge tone="done">Paid</StatusBadge>
          <StatusBadge tone="due">2 to sign</StatusBadge>
          <StatusBadge tone="late">Overdue</StatusBadge>
          <StatusBadge tone="info">Waiting for QuickBooks</StatusBadge>
          <StatusBadge tone="neutral">Not started</StatusBadge>
          <Badge>Admin</Badge>
          <Badge tone="club">New</Badge>
        </div>
        <div className="ds-samples">
          {(["done", "due", "late", "info", "neutral"] as const).map((t) => <span key={t} className="ds-tone"><StatusIcon tone={t} />StatusIcon {t}</span>)}
        </div>
      </Section>

      <Section id="card" name="Card" use="A titled region of a page: what a family owes, its students, a setting. M3's filled card: its fill on the page's ground, 20px corners, no edge. Its title names the region for screen readers. Actions sit at the foot, or beside the title with headActions. tonal fills one region with the club's primary container (Home's new messages): at most one a page, never the money card. Never a card inside a card." importLine={UI("Card")}>
        <div className="ds-pair">
          <Card title="Sample Family" titleId="ds-card-a" description="A quiet line under the title" actions={<LinkButton variant="outlined" plain href="#ds-card">See your payments</LinkButton>}>
            <p className="help">The card&apos;s content: words, a List, a DataTable or a form.</p>
          </Card>
          <Card title="A much longer title that has to wrap onto a second line on a phone" titleId="ds-card-b" headActions={<Button size="sm" variant="tonal">Edit</Button>}>
            <p className="help">With headActions the action sits beside the title and wraps under it when there is no room.</p>
          </Card>
          <Card tonal title="1 new message from the club" titleId="ds-card-c" actions={<LinkButton plain href="#ds-card">Read it in Messages</LinkButton>}>
            <p>A sample: the one region a page makes stand out.</p>
          </Card>
        </div>
      </Section>

      <Section id="list" name="List and ListRow" use="The core of the look: M3 Expressive's segmented list. Each row is its own tile, 2px apart, the group rounded at its ends; each a 40px status circle in its tone's container, its words, a title, a meta line, then an amount or a compact action. Use it for To do, Students, Payments and any short list a person acts on; ListTotal under a list of amounts sums them. A long list of records with columns is a DataTable." importLine={UI("List, ListRow, ListSubRow, ListTotal, SectionLabel")}>
        <div className="ds-samples stacked">
          <div>
            <SectionLabel level={3}>To do</SectionLabel>
            <List>
              <ListRow status={{ tone: "due", words: "2 of 3 left" }} title="Sign Sam's forms" meta="Due Nov 15" action={<LinkButton plain size="sm" href="#ds-list">Sign</LinkButton>} />
              <ListRow status={{ tone: "late", words: "Was due Oct 30" }} title="Sample trip deposit, Alex" amount={formatMoney(10000)} action={<LinkButton plain size="sm" href="#ds-list">Pay</LinkButton>} />
              <ListRow status={{ tone: "due", words: "Due Nov 22" }} title="Sample uniform fee with a long name that wraps onto a second line, Sam Sample" amount={formatMoney(8500)} action={<LinkButton plain size="sm" variant="tonal" href="#ds-list">Pay</LinkButton>} />
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
                action={<><Button size="sm" variant="text">Rename</Button><Button size="sm" variant="danger">Remove</Button></>}
                detail={<p className="help">Removing your last passkey means we ask for the emailed code again.</p>} />
              <ListRow title="Pancake breakfast, Griddle" meta={["Saturday, 7:00 am to 9:00 am", "You're doing this one"]}
                detail={<><span className="state">Signed up</span><Button size="sm" variant="tonal">Cancel my sign-up</Button></>} />
            </List>
          </div>
          <div>
            <SectionLabel level={3}>Rows that are one link each, with a logo (the Integrations page)</SectionLabel>
            <List label="Sample integrations">
              <ListRow href="#ds-list" logo={<IntegrationLogo of="mail-graph" />} title="Microsoft 365" meta="Sends as webmaster@sample.org." trail={<StatusDot tone="done" words="Working" />} />
              <ListRow href="#ds-list" logo={<IntegrationLogo of="mail-smtp" />} title="SMTP" meta="Sends through any mail server that takes a user name and password." trail={<StatusDot tone="neutral" words="Not in use" />} />
              <ListRow href="#ds-list" logo={<IntegrationLogo of="documenso" />} title="Documenso" meta="Sends each form to sign and tells the portal when it is signed." trail={<StatusDot tone="due" words="Not checked yet" />} />
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
          <PageHeader sample back={{ href: "#ds-page-header", label: "Back to Roster" }} title="Sample Family" lede="2 students · 1 guardian · as of 2:14 pm" actions={<><Button variant="outlined">Rename</Button><Button>Add a student</Button></>} />
        </div>
      </Section>

      <Section id="section-label" name="SectionLabel" use="The small heading over a List or a table on a page that has several (Home's To do, Students). A real heading, drawn quietly." importLine={UI("SectionLabel")}>
        <div className="ds-samples"><SectionLabel level={3}>Students</SectionLabel></div>
      </Section>

      <Section id="empty-state" name="EmptyState" use="Where a list or table has nothing yet: say what will be here, kindly, and the one action that fills it." importLine={UI("EmptyState")}>
        <EmptyState title="No volunteer events yet" action={<Button>Add an event</Button>}>When you add one, families see it on their Volunteer page.</EmptyState>
      </Section>

      <Section id="drawer" name="Drawer" use="A form behind a button: a repeated form on a row (Waive for…, Change the student…) or a secondary one on a page. The button says what the form does; it opens M3's modal side sheet from 600px wide (a full-screen sheet on a phone), with a close icon button and 56px buttons at its foot. It has its own address (?param=value): Back closes it, a refresh opens it again, and without JavaScript the button is a link to the page with the form drawn in it. The focus goes in, stays in, and comes back to the button; Esc and Close close it." importLine={UI("Drawer")}>
        <DrawerSample />
      </Section>

      <Section id="confirm-dialog" name="ConfirmDialog" use="One press that needs a second look: a button with the action's words, then M3's basic dialog (28px corners, a centered title, the alert icon for a destructive one) with one sentence of what follows, an optional box to tick or a reason to type, and at its end Cancel, a text button that has the focus first, then the action's own button, filled. Not for a form: that is a Drawer." importLine={UI("ConfirmDialog")}>
        <ConfirmSample />
      </Section>

      <Section id="steps-choice" name="StepsChoice" use="Two ways to do one task, such as by hand or with a script: M3 Expressive's connected button group in the open (the chosen one round, in the secondary container), the chosen way's one line under it, and only its steps below." importLine={UI("StepsChoice")}>
        <StepsChoiceSample />
      </Section>

      <Section id="stat" name="Stat" use="One figure that matters on a staff page, with its label. Group a few in .stats. Not a hero number on a parent page: there the amount sits in its card." importLine={UI("Stat")}>
        <div className="stats">
          <Stat label="Owed by families" value={formatMoney(124050)} meta="38 open invoices" />
          <Stat label="Forms signed" value="112 of 140" meta="28 still to sign" />
          <Stat label="Volunteer hours" value="86" />
        </div>
      </Section>

      <Section id="fields" name="Fields" use="TextInput, TextArea, Select and Checkbox, each with its label above it (never floating, never a placeholder), a hint and an error tied to the control with aria-describedby. Fields are M3's outlined field, 56px tall; tick boxes and radios are M3's, in a 48px target. ChoiceGroup for a few options that need explaining: a chosen tile turns the secondary container. The id comes from the page." importLine={UI("TextInput, TextArea, Select, Checkbox, ChoiceGroup")}>
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

      <Section id="rich-text-editor" name="RichTextEditor" use="A body of rich text a person writes (a club message): its label and hint over a frame with the toolbar (undo and redo, two headings, two lists, bold, italic, underline, a link, and a picture where the form takes them) and the writing area. It offers only what src/lib/messages/body.ts keeps; the server checks what it sends. The form reads what was written through its ref. Tiptap, with the look of Tiptap's Simple Editor template. Not for a line of plain text: that is a TextInput or TextArea." importLine={`import { RichTextEditor, type RichTextHandle } from "@/app/components/rich-text-editor";`}>
        <RichTextEditor id="ds-body" label="Message" hint="Some words or a picture. Headings, bold, italic, underline, lists, links and pictures."
          initial={{ type: "doc", content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Sample practice news" }] },
            { type: "paragraph", content: [{ type: "text", text: "Practice moves to " }, { type: "text", text: "Friday", marks: [{ type: "bold" }] }, { type: "text", text: " this week." }] },
            { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Bring water" }] }] }] },
          ] }} />
      </Section>

      <Section id="avatar" name="Avatar" use="A person's initials beside their name. The club bar's account control is one: a 40px disc on the club's primary container in a 48px target." importLine={UI("Avatar")}>
        <div className="ds-samples"><Avatar initials="AS" /><Avatar initials="SS" club /><Avatar initials="RS" size="sm" /><span className="account" aria-hidden="true">AS</span></div>
      </Section>

      <Section id="step-indicator" name="StepIndicator" use="Where something stands in a short sequence of steps: the season's steps on Home. Done steps are ticked, the current one is the club's primary and named in words. Not a control." importLine={UI("StepIndicator")}>
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

      <Section id="toolbar" name="Toolbar" use="Filters over the table or list they scope, actions at the end (56px, level with the fields). It wraps on a phone." importLine={UI("Toolbar, TextInput, Select")}>
        <Toolbar label="Filter invoices" end={<Button variant="outlined">Clear</Button>}>
          <TextInput id="ds-search" label="Search" type="search" placeholder="A name or invoice" autoComplete="off" />
          <Select id="ds-state" label="State" defaultValue="open"><option value="open">Open</option><option value="paid">Paid</option></Select>
        </Toolbar>
      </Section>

      <Section id="data-table" name="DataTable" use="Many records with the same columns: the roster, Balances, the audit log. M3 has no data table, so this is ours on M3's tokens: title-small headers on the highest container, rows at least 56px with a hover layer, a ticked row in the secondary container. Numbers right-aligned in tabular figures; a quiet column for row actions. Below 840px each row stacks, label beside value." importLine={UI("DataTable, type Column")}>
        <DataTable caption="Sample invoices" columns={invoiceColumns} rows={INVOICES} rowKey={(i) => i.id} />
        <DataTable caption="Grouped by family" columns={invoiceColumns} groups={[{ key: "g", heading: "Sample Family", rows: INVOICES.slice(0, 2) }]} rowKey={(i) => `g${i.id}`} />
        <h3 className="table-head">Bulk select</h3>
        <p className="ds-note">Inside BulkSelect, <code>select</code> puts a tick box on each row (&quot;Select&quot; and the row&apos;s name) and one in the header, mixed when some are ticked. M3 Expressive&apos;s floating toolbar stays in view while any are, a raised pill on the club&apos;s primary container: the count, read out as it changes, the actions, and Clear; with the page ticked and more rows matching, &quot;Select all M that match&quot;. On a phone the actions are one &quot;N selected · Actions&quot; button. A bulk action sends <code>selectionPayload()</code>, ids from the browser: the server checks every one again before it acts, and works out &quot;all that match&quot; from its own query. Its Drawer says first what would happen to each row, then what did.</p>
        <BulkSample />
      </Section>

      <Section id="notice" name="Notice and ActionOutcome" use="A status that stands apart: information, needs attention, done, a problem, on its tone's container with its icon and bold word (ours: M3 has no banner, and a snackbar never answers an action). ActionOutcome shows what a server action answered, in place. A problem is announced as an alert, the rest as a status. An answer that replaces the form that was pressed takes the focus: give it a ref (and Notice tabIndex={-1})." importLine={UI("Notice, ActionOutcome")}>
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
        <p className="ds-use">StatusDot: a quiet one-line status beside a name, its words with a dot that only repeats them (the Settings rail, an integration row).</p>
        <div className="ds-samples"><StatusDot tone="done" words="Connected" /><StatusDot tone="due" words="Needs attention" /><StatusDot tone="neutral" words="Not set up" /></div>
      </Section>

      <Section id="settings-rail" name="Settings list pane" use="M3's list-detail layout for Settings: the list pane beside every settings page from 840px (SettingsRail, drawn by settings/layout.tsx), Find a setting, then sentence-case groups of items, each with its status, the current one in the secondary container. On a phone it is Settings' first screen, each group a segmented list. Drawn here as a sample, without its search." importLine={`import { SettingsRail } from "@/app/staff/(app)/settings/settings-rail";`}>
        <div className="settings-rail is-root ds-rail" aria-label="Sample settings rail" role="group">
          <p className="rail-title">Settings</p>
          {([["People and access", [["Staff", "done", "6 people", false], ["Roles", "done", "4 roles", true]]], ["Connections", [["Integrations", "due", "1 needs attention", false]]]] as const).map(([group, items]) => (
            <div key={group} className="rail-group">
              <p className="rail-label">{group}</p>
              <ul>{items.map(([name, tone, words, current]) => (
                <li key={name}><a href="#ds-settings-rail" aria-current={current ? "page" : undefined}><span className="rail-name">{name}</span><StatusDot tone={tone} words={words} className="rail-status" /></a></li>
              ))}</ul>
            </div>
          ))}
        </div>
      </Section>

      <Section id="time-money" name="LocalTime, CalendarDate and formatMoney" use="An instant in the viewer's own time, a calendar date the same for everyone, and an amount in tabular figures. Never format these yourself." importLine={`import { LocalTime, CalendarDate } from "@/app/components/ui";  import { formatMoney } from "@/lib/money/cents";`}>
        <div className="ds-samples"><LocalTime iso="2026-11-21T19:14:00Z" /><CalendarDate iso="2026-11-22" /><span className="num">{formatMoney(18500)}</span></div>
      </Section>

      <Section id="frame" name="Club bar, rail and tabs" use="The frame every page sits in. ClubBar is M3's small top app bar, 64px: the club's logo tile in its exact color, its name, and the account. A parent's places are links in the bar from 840px (the current one on M3's pill) and M3's navigation bar at the foot below that, labels always shown. Staff have the expanded navigation rail from 1200px, always open, every group's pages under its heading, and below 1200px the same navigation bar with Home, the groups and Settings. The current place is the secondary container and bold, never the color alone. Drawn here as samples." importLine={`import { ClubBar } from "@/app/components/club-bar";  import { StaffRail } from "@/app/components/top-nav";`}>
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
        <div className="ds-frame ds-frame-rail">
          <nav className="staff-rail ds-show" aria-label="Sample staff rail">
            <a href="#ds-frame"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z" /></svg>Home</a>
            <div role="group" aria-labelledby="ds-rail-families">
              <h4 id="ds-rail-families" className="rail-heading">Families</h4>
              <a href="#ds-frame" aria-current="page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>Roster</a>
              <a href="#ds-frame"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z" /></svg>Messages</a>
            </div>
            <div role="group" aria-labelledby="ds-rail-money">
              <h4 id="ds-rail-money" className="rail-heading">Money</h4>
              <a href="#ds-frame"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></svg>Balances</a>
            </div>
            <hr className="rail-rule" />
            <a href="#ds-frame"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4" /></svg>Settings</a>
          </nav>
          <div className="ds-pane"><p className="page-title">Roster</p><p className="lede">The page sits in a pane beside the rail, with extra-large top corners.</p></div>
        </div>
      </Section>
      <Section id="powered-by" name="Powered by" use="The product's credit, the club leading everywhere else (brand/BRAND.md). One ink in the footer of every portal page, parent and staff; in the product's colors under the sign-in form. A link to boostersrocket.com whose name says so. No club setting removes it; never put the product's indigo or flame anywhere else in the portal." importLine={`import { PoweredBy } from "@/app/components/powered-by";`}>
        <div className="ds-pair">
          {MODES.map(({ mode, label, theme, contrast }) => (
            <div key={mode} className="theme-sample" data-theme={theme} data-contrast={contrast}>
              <p className="section-label">{label}</p>
              <PoweredBy />
              <PoweredBy variant="color" />
            </div>
          ))}
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
