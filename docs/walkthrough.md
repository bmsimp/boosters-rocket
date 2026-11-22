# Walkthrough: every journey, walked in a browser

Walked on 2026-11-16 by the walk slice (roadmap step 7), on branch `slice/walk`, in Chromium at **390** wide (a phone)
and **1440** wide (a laptop), each against the built app (`pnpm build`, `pnpm start`) on the browser seed
(`scripts/seed-e2e.ts`), with the mail sink catching the portal's mail. QuickBooks can't be reached from here: money
was read from the seed's stored figures, and every write was seen to be refused before it was sent (the seed's
QuickBooks ids are not digits, `isQboId`). Forms were walked twice: from the seed's stored states in the browser
suite, and once for real against the local Documenso by hand (below).

Each entry says where it was, at which width, what a person would have met, and what became of it: **fixed** (with
the commit on `slice/walk`, merged on `parent-portal` the same day, or on the branch it names), or **open** (with how big a fix it is; every
open one is also in `docs/ui-backlog.md`). "Both" means 390 and 1440.

## How the walk is kept

| What | Where | How it runs |
|---|---|---|
| A parent's whole visit: the password and the emailed code (since the sign-in release's slice SI-3b), choosing a family, Home (since slice SI-8 its passkey offer first, answered Not now), a signed form and its download, Payments, two shift sign-ups cancelled again, checking in, a buy-out and a switch back (both refused before anything is sent), their details, the display, the manifest and its icons, signing out | `tests/e2e/journey-parent.spec.ts` | In every browser run, both passes |
| A staff member's session: the staff home, the grouped menu, the roster and a family, its money, Parents, a new season with a requirement of each kind, a waiver the parent reads only as "Waived", a volunteer event with a shift and its check-in sheet, a credit correction, the signed-forms matrix and one evidence page, Balances, Reconciliation, the audit log and its export, Health and Settings | `tests/e2e/journey-staff.spec.ts` | In every browser run, both passes; what it makes is taken away again |
| Their shared steps (the emailed code, the staff menu, no sideways scroll) | `tests/e2e/journey-helpers.ts` | |
| Pictures of each step, for a walk like this one | `WALK_SHOTS=<a folder outside the repository>` set when running either spec | Only when set; an ordinary run writes nothing |
| Signing a form in the embedded frame, for real | `scripts/walk-forms-by-hand-local-documenso.ts` | By hand, against the local Documenso (below) |

The journeys the browser suite already proved piece by piece stay where they are: the email change
(`family-email.spec.ts`, which needs parent sign-ins on and Zelda in one family, so it runs at phone width only),
parent sign-ins switched on (`parents.spec.ts`), the install hint and the service worker
(`pwa.spec.ts`), the grouped menu by keyboard (`staff-menu.spec.ts`), setup reopened (`setup.spec.ts`).

### Running the forms walk against the local Documenso

The browser suite never reaches a Documenso. The local one step 4 verified (compose project `br-documenso-spike`,
`http://localhost:3500`) is walked by hand:

1. In this worktree, export the variables of a browser run in a worktree (docs/agents/testing.md), then `pnpm build`,
   `pnpm tsx scripts/seed-e2e.ts`, and start the app with them: `NODE_EXTRA_CA_CERTS=$PWD/.e2e/sink-cert.pem pnpm start -p $E2E_PORT`.
2. With the same variables:
   `DOCUMENSO_ACCOUNT=<the local Documenso's account.json> WALK_OUT=<a folder for pictures> WALK_WIDTH=390 pnpm tsx scripts/walk-forms-by-hand-local-documenso.ts`
   (`WALK_WIDTH` is 1440 when left out). The account file holds the API token and the template ids; it stays outside
   the repository and is read when the script runs. Nothing secret is printed.
3. It ends with `SIGNED: the form reads as signed.` when the whole journey worked: the Admin set up Forms, checked the
   connection and made the webhook secret; attached the local template to "Medical release"; and Zelda chose "Sign for
   Xochitl", agreed, signed in the frame and read the form as signed once Documenso sealed it.
4. Seed again afterwards: the walk leaves Forms set up and a signed document behind, which the browser suite doesn't
   expect.

On 2026-11-16 it ended `SIGNED` at both 390 and 1440.

## A parent

| Where | Width | What a person met | What became of it |
|---|---|---|---|
| Sign-in, the code, the family chooser | Both | Worked: the code arrived in the mail sink, the chooser named both families, Home opened on the one chosen. | Nothing to fix |
| Home | Both | Worked: what is owed, the ruler on step 2 of 4, each student's line, the parent's details. | Nothing to fix |
| Forms | Both | Above the family's **signed** travel consent the page said "The club's forms aren't ready to sign yet", as if that one weren't signed either. | **Fixed** (`5ede4fb`): the note speaks of the forms still to sign, and is left out when there are none |
| One signed form | Both | "Signed" said three times over: the box's heading, its state and "This form is signed. Thank you!". | **Fixed** (`a56929c`, `slice/finish`): the heading is "This form", the state says "Signed" with its tick, and the thanks says there is nothing more to do |
| Payments | Both | Worked: each open invoice, the Pay link to QuickBooks' page, the total, what was paid. The buy-out's invoice reads "Invoice QZ-1042" like any other, with nothing saying it is the volunteering buy-out. | **Fixed** (`7dd19e7`, `slice/finish`): the line reads "Paying instead of volunteering: Concession help", found by the family's own buy-outs |
| Volunteer, a shift that has started | 390 | Zelda's place on tonight's shift said "It's less than 48 hours before the shift, so it can't be cancelled here", which is no longer the point once it has begun, and nothing said what to do now. | **Fixed** (`3892839`): it says the shift has started and to scan the club's check-in code there |
| Signing up and cancelling | Both | Worked: the count, the place, the calendar email, cancelling with a second tap. | Nothing to fix |
| Checking in | Both | Worked: "Check me in", then "Checked in" on the shift and on Volunteer. | Nothing to fix |
| Paying instead, and switching back | Both | Both refused before anything was sent, in calm words ("nothing has been billed", "nothing was changed"). In a real club the retry advice holds; here every retry is refused by the seed's ids. | Nothing to fix |
| Family, Update my details | Both | The record's id is not digits, so the page says the club's books can't be reached and offers no form: the walk can't go further here. The edit itself is proved against the stub (`tests/integration/contact-edits.test.ts`). Since stage 3's slice 11a the details are the portal's own: the page shows its form in the browser run too, and `tests/e2e/family-details.spec.ts` saves a change. | Nothing to fix |
| Sign-in settings (the sign-in release's slice SI-5a) | 1440 | Not walked by hand yet. Walked by journey 10 of `keyboard-journeys.spec.ts`: from Family's "Your account" box, the password, the emailed code, then the change form's fields (never sent) and Sign out everywhere (never pressed); since slice SI-6b, journey 11 sets an authenticator app up in the box below the devices, copies the key and the backup codes, asks again with the app and turns it off, and `authenticator.spec.ts` signs in on two new browsers with its code and a backup code; since slice SI-7b, `passkeys.spec.ts` adds a passkey in the "Passkeys" box, reads its backup codes once, renames it, asks again with it, signs in with it alone on a fresh browser and removes it (not yet by keyboard: `docs/accessibility-checks.md`, 12). | Nothing found yet |
| Change my sign-in email | 390 | Walked by `family-email.spec.ts`, its session stamped as just proved since slice SI-5a (the page asks again otherwise): asked, the link arrived, opening it asked, confirming was refused before anything was sent. With two families Zelda reads "Your sign-in email can't be changed here", as the rule said. Since stage 3's slice 11d the change is the portal's own and offered in any number of families: the browser run offers it to Zelda, and its confirm is refused only because another person holds the address (`family-email.spec.ts`). | Nothing to fix |
| Display, the install hint, the manifest and icons | Both | Worked: dark applies at once and back; "Add the portal to your home screen" with the steps; the manifest names the club; every icon is a PNG. | Nothing to fix |
| Signing a form in the frame (local Documenso, by hand) | Both | Worked end to end. At 390 Documenso's "Sign" button in its signature dialog sat under the portal's tab bar until the page was scrolled so the frame starts at the top of the screen; a person can scroll it clear, an automated tap couldn't. | **Open**, owner check: try it on a real phone (the roadmap's checks table already asks for one); if a thumb can't reach "Sign", make the frame fit above the tab bar (`.sign-frame iframe` in the Forms block, small) |

## Staff

| Where | Width | What a person met | What became of it |
|---|---|---|---|
| First-time setup, on an empty database | Both | Walked to the last step: unlock, the club's name, color and time zone, staff sign-in, mail by SMTP to the mail sink with a test email that arrived, the first Admin's name and email. It stops at "Sign in with Google", which needs Google itself. | The rest is the owner's (a real Microsoft or Google sign-in) |
| Setup's buttons | Both | The Unlock button, each step's Next button and the "This portal's address" box sat flush against the box or form above them, reading as one block. | **Fixed** (`265109c`) |
| Setup, staff sign-in with Google | Both | Made-up Google values answered "Checked and saved.", though nothing can ask Google about them without a person signing in. | **Fixed** (`9b59c54`): it says they were saved and that the first sign-in proves them |
| Setup and Settings, outgoing mail | Both | With Google sign-in only, the boxes are numbered 1 and 2 but said "Save the settings in step 2 first" and "Send a test email next, in step 3". "Send with" drew one lone, unstyled browser radio button. | **Fixed** (`6b814ca`): the guide passes each box the other's number; SMTP alone draws no radio, and the choice uses the ruled marks when Microsoft 365 is offered |
| Setup, the first Admin | 1440 | "Save name and email" says nothing when it has worked; the sign-in button simply appears under it. | **Fixed** (`d78381e`, `slice/finish`): "Saved. Now sign in below as the Admin." in a done notice |
| Staff home | 1440 | The two Today lines put "Open Reconciliation" at the end of one line and under the words on the next, only because one description was longer. | **Fixed** (`44b0068`) |
| A family's roster page | Both | A dead end: reading the same family's money, season or volunteering credit meant going back to another list and finding it again. | **Fixed** (`d92f4e2`): "More about this family" links each, for staff who may open it |
| Parents | Both | "To review (0)" before parent sign-ins are on, while Reconciliation's "Needs attention" already names Sam's address under two families and says someone with Parents must decide. It does say "once parent sign-ins are on", but a reader goes to Parents and finds nothing to decide. | **Fixed** (`691c878`, `slice/finish`): before sign-ins are on, To review says an address under more than one family is held and comes up there once they are. **Gone since** stage 3's slice 7a of the app-owned families work: held addresses, To review and that Needs attention item were retired, and a guardian in two families simply belongs to both |
| Seasons, a new season | Both | "Start with no steps" answered on the Seasons list and left the new season to be found in the table before a step could be added. | **Fixed** (`1d89993`): it goes on to the new season's page, as a new volunteer event does |
| A requirement of each kind | Both | Worked: checklist, form, payment and volunteering each added. A payment requirement is added with no item: it is chosen on the requirement's page afterwards, and nothing on the step says one is still needed. | **Fixed** (`2dbd5b0`, `slice/finish`): the step's line reads "No QuickBooks product or service chosen yet" until one is |
| Tick and waive | Both | Worked: the waiver's reason is shown to staff and in the audit log; the parent's Season page says "Waived" and never the reason. | Nothing to fix |
| A volunteer event, its sign-up list and check-in sheet | Both | Worked: the event, a shift, "Nobody has signed up yet", the printable QR code and its address. | Nothing to fix |
| Volunteer credit | Both | Worked: an hour credited with a staff-only note, then removed with a reason; the row stays, marked removed. | Nothing to fix |
| Signed forms matrix | 390 | "Medical release", which has no template, reads "Not opened yet" for every student, though it can't be opened; and "Remind" is offered for families whose only outstanding form can't be signed yet. | **Fixed** (`19004ee`, `slice/finish`): a "Not ready yet" cell state and filter, no "Remind" for a family whose only outstanding forms have no template, and a test that the scheduled reminders pass such a form over |
| One form's evidence, its download | Both | Worked. | Nothing to fix |
| Balances, a family's money | Both | Worked: every family, "Worth a look", one family's invoices. | Nothing to fix |
| Reconciliation | 1440 | "Try again now" broke over three lines in its narrow column. | **Fixed** (`56ff422`) |
| Audit log and export | Both | Worked: the walk's own rows, newest first, and the CSV. At 390 a row's details are long JSON lines, wrapped. | Nothing to fix |
| Health | Both | Worked: one line per part in words. | Nothing to fix |
| Settings and the grouped menu by keyboard | Both | Worked (`settings.spec.ts`, `staff-menu.spec.ts`, and the staff journey through every group). | Nothing to fix |

## The notice redesign (design check)

The owner's design check flagged three side-tab accents in `src/app/booster.css`: the Notice primitive's 8px colored
rule down its left edge (and its forced-colors twin) and the roles page's patterns warning (a 4px amber rule). They
were redesigned in DESIGN.md's own language (`6bd1f18`, `56ff422`): every notice is ruled evenly all round in 2px ink,
like every box, and its tone is carried by what it says: a 28px icon cell filled with the tone's ink, the icon drawn in
paper, and the word in the tone's ink. Under forced colors the cell is drawn in system colors with an edge. The
patterns warning is now a needs-attention Notice. Checked at 390 and 1440 on the staff home, Health, Reconciliation,
Settings, a role written with patterns, setup's steps, the season and volunteer pages and Volunteer credit, in light,
dark, both high-contrast sets and forced colors. No parent page uses a notice or a one-sided panel. The design check
(`impeccable detect src/app/booster.css`) reports no side-tab finding after the change.
