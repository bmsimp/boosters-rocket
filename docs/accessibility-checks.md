# Accessibility checks of the parent pages

What was checked by hand on the parent pages, the pages before sign-in and the parent frame, what was found and
what was fixed. The automatic checks are `tests/e2e/parent-a11y.spec.ts` (every parent page, at 360 and 1440 wide,
in every display mode and in forced colors, against axe-core's WCAG 2.0 to 2.2 A and AA rules and the portal's own
checks for sideways scrolling, clipped or overlapping text and tap targets, and a Tab walk that fails a stop with
no focus ring or one left under the phone's tab bar). Add a dated section when the journeys are walked again.

## 2026-11-17, step 8: the journeys are a committed test

`tests/e2e/keyboard-journeys.spec.ts` now walks these journeys by keyboard alone in the browser run (desktop pass, 1440
wide; `parent-a11y.spec.ts` keeps walking every page with Tab at 360): Tab, Shift+Tab, Enter, Space, the arrow keys and
typing, nothing clicked. At every Tab stop it fails a missing focus ring; it fails a control the keyboard can't reach
in the page's order, and a page the keyboard can't Tab out of; and after each action it checks where the focus lands.

| Journey | What the test holds |
|---|---|
| 1. Signing in with a password and an emailed code | The first stop is the email field, then the password, then Sign in. Enter checks the password and, on a browser the portal doesn't remember, the code field takes the focus; a wrong code is an alert with the focus left in the field; Enter signs in; the chooser's family button by Tab and Enter. |
| 2. Home to Payments | "Skip to the page" is the first stop, drawn while focused (44px), and the next Tab lands past the club bar and the Switch family line. The bar's order (Skip, Home, Forms, Payments); after Enter on Payments the focus stays on its link; the Pay link is reached and named with its amount and invoice (not followed: it is Intuit's page). |
| 3. Opening a form | The family's signed form opened by keyboard; its page title is the form's name; the download and Back to Forms are reached. Agreeing and Documenso's frame are not: forms are not set up in the seed (below). |
| 4. Signing up for a shift and cancelling | The choice group is one stop, then Sign me up; the thank-you takes the focus. Cancel my sign-up puts the focus on Keep it, inside the group "Cancel my sign-up?"; Keep it gives it back; Shift+Tab reaches Yes, cancel it; the cancelled message takes the focus. |
| 5. Checking in | Check me in by Enter; the box's status line takes the focus; Tab then leaves the page. |
| 6. The details form | Family, Update my details and Back to Family by keyboard. The form itself is not: the run can't reach QuickBooks, so the page shows only its note (below). |
| 7. The email change | An address with no "@" keeps the focus in the field; the good one is announced with the focus left on Send me a link; on the emailed link's page, the refused Yes keeps the focus with its alert. |
| 8. The Display page | Each choice group is one stop and the arrow keys choose (Dark sets `data-theme="dark"`, Match my device takes it off); Contrast, Text size and Motion follow, then Sign out, which signs out. |

Still walked only by hand, or not at all, because the browser run can't reach the service: agreeing to sign and the
signing frame (journey 3's second half, against the local Documenso as in step 6), saving the phone and address form
(journey 6), and paying instead of volunteering (journey 9).

Found while making it: a form's page was titled "Form", and every page made the keyboard pass the club bar's stops
first. A form's page is now titled with its name, and every club bar that has links starts with "Skip to the page",
on staff pages too (both were "For later" in the section below).

## 2026-11-16, step 6

### How

- **Keyboard only**, driven through Playwright 1.65's Chromium against the production build (`pnpm build`, the
  seed from `scripts/seed-e2e.ts`): Tab, Shift+Tab, Enter, Space and the arrow keys, nothing clicked. For each page
  on the way, the Tab order from the top was written down, and every Tab stop's focus ring was measured (outline
  style, width and color) at 360 and 1440 wide in light, dark, high contrast light, high contrast dark, larger text
  and forced colors.
- **What a screen reader is told**: a recorder in the page noted every word put into a `role="status"`,
  `role="alert"` or `aria-live` region after each action, and where the focus was when the page settled. That is
  what a screen reader announces from the page's side.
- **No screen reader was listened to.** Narrator is on this machine, but the agent that walked the journeys can't
  hear speech, so what Narrator says was not checked by ear. The owner's checks below ask for that.
- **Forms** were walked against the local Documenso (the `br-documenso-spike` stack on port 3500), with the e2e
  database's Forms settings pointed at it and its test template attached to the seeded Medical release. The browser
  test run never does this: its seed leaves forms unset, so it can't reach a Documenso.

### 1. Signing in with a password and an emailed code (`/sign-in`, `/choose-family`)

Since the sign-in release's slice SI-3b. `tests/e2e/keyboard-journeys.spec.ts` walks it by keyboard on every run;
the hand walk below was made on the code door before it and has not been made again on the password form.

- Tab order: Email, Password, Sign in, "Set up or reset my password", "Board and staff sign in here". On the code
  step (a device the portal doesn't remember): the code field, Sign in, Resend code (waiting, so skipped), Start
  again, then the same two links. The chooser: each family, then Sign out. Every stop has a ring in every mode (3px
  club text, 4px in high contrast, Highlight in forced colors).
- Enter on Sign in checks the password. A refusal is announced as an alert ("That email and password didn't work…"
  with a link to "Set up or reset my password") and the focus stays where it was. A right password on a new device
  moves to the code step: its status ("To finish signing in on this device, enter the 6-digit code we've emailed
  you…") is announced and the focus is in the code field. A wrong code is announced as an alert and the focus stays
  in the field. The right one goes to the chooser, then Home. On a device the portal remembers, the password alone
  goes to the chooser.
- **Found and fixed:** "Board and staff sign in here" was a 207 by 21px target standing alone on its line (now 44px
  tall, `.link-line`). Send code and Sign in were disabled while busy, which drops the focus when pressed from the
  button: they are now `aria-disabled` while busy, and each step focuses its own field when the form moves to it
  (also after "Use a different email", now "Start again", and after Resend).
- Left as it is: a page load (the chooser, Home) starts the focus at the top of the page, as every full page load does.

### 2. Home to Payments and a Pay link (`/`, `/payments`)

- Home's order: the club bar's links (Home, Forms, Payments, Volunteer, Family), the account link, Switch family,
  See the whole season, the Pay link, See your payments, Update my details. At 360 wide the bar has only the account
  link and the tabs come last, where they sit on the screen. Every stop has a ring in every mode; inside the club bar
  the ring is `club-on`, as DESIGN.md says.
- Payments' Pay link is named "Pay $85.00, invoice QZ-1041 for Xochitl Quetzalcoatl", opens Intuit's page in the same
  tab, and has `rel="noopener noreferrer"`. After following a tab or nav link, the focus stays on that link (Next.js
  keeps the frame) and Next.js's route announcer reads the new page's title.
- **Found and fixed:** the account link shows the initials (ZQ) and was named only "Your account and display
  settings, Zelda Quetzalcoatl", so speech input users saying what they see couldn't reach it (WCAG 2.5.3, Label in
  Name; axe-core's `label-content-name-mismatch` on every parent page). Its name now starts with the initials:
  "ZQ: Your account and display settings, Zelda Quetzalcoatl".
- The Pay button that is paused while the figures are not current could not be reached with the seed (its figures are
  fresh); its words are in DESIGN.md and its markup is `aria-disabled` with the reason in its name.

### 3. Opening a form, agreeing, and reaching the signing frame (`/forms`, `/forms/[id]`)

- The Forms page's links say what they open ("Sign for Xochitl: Medical release"; the colon is hidden text).
  The form's page: Back to Forms, then "I agree to sign electronically". Rings in every mode.
- Agreeing makes the document in Documenso and brings the page back with the frame, titled "Sign: Medical release".
  Tab goes into Documenso's page (its own controls: Actions, a button with no name, Next Field) and out again to
  "Check whether it's signed": the frame does not trap the keyboard.
- **Found and fixed:** after agreeing the focus was on nothing and nothing was said, so a keyboard or screen reader
  user had to find the frame from the top. The frame now takes the focus once the guardian has agreed (not when the
  page is opened already at the signing step), and wears the focus ring while the keyboard is inside it. The busy
  buttons on this page keep their focus (`aria-disabled`).
- Not ours to fix: one of Documenso's buttons inside the frame has no accessible name. It is Documenso's page; worth
  telling Documenso upstream.
- Not signed through to the end: signing inside the frame is Documenso's page, and the states after it (waiting,
  finishing, signed) were read from the code and the seeded signed form, whose page has a Download link with a ring.

### 4. Signing up for a shift and cancelling (`/volunteer`, `/volunteer/shifts/[id]`)

- The shift page: Back to Volunteer, the "Who will do this shift?" choice group (one Tab stop; the arrow keys move
  between the people and change the button's words to "Sign up Xochitl Quetzalcoatl"), then the Sign up button.
  The checked option and the focused one each have a ring; rings in every mode.
- **Found and fixed:**
  - After signing up, the form was replaced by its thank-you and the focus fell to the page. The thank-you now takes
    the focus (and is still announced as a status).
  - Cancelling: "Cancel my sign-up" was replaced by "Yes, cancel it" and "Keep it" with the focus on nothing, and
    "Keep it" left it on nothing again. The question now puts the focus on "Keep it" (the choice that changes
    nothing), inside a group named "Cancel my sign-up?", so a screen reader says what is asked; "Keep it" gives the
    focus back to "Cancel my sign-up"; Shift+Tab reaches "Yes, cancel it".
  - A cancelled place leaves the list, so its message ("Cancelled. Your place is free for someone else now…")
    vanished with it, never shown or announced. It now goes to a status line the box keeps
    (`src/app/(parent)/announce.tsx`), which is announced and takes the focus.
  - These buttons were disabled while busy; now `aria-disabled`, so they keep the focus.

### 5. Checking in at a shift (`/volunteer/check-in/[code]`)

- Order: the club bar, Switch family, "Check me in", "Back to Volunteer". Rings in every mode.
- **Found and fixed:** "Back to Volunteer" was a 126 by 18px target alone on its line (now 44px, `.link-line`).
  Checking in redraws the page with "Checked in" in place of the button, so its message ("Checked in: you. Thank
  you for helping!") went with the button, unannounced, and the focus fell to the page. It now goes to the box's
  status line, which is announced and takes the focus.

### 6. Editing the phone and address (`/family`, `/family/details`)

- Family's order: the club bar, Switch family, Update my details, Switch family (the account box). Rings in every
  mode.
- The browser run can't reach QuickBooks (the seed's ids are not digits, so nothing is sent to Intuit), so the details
  page shows only its note ("We can't reach the club's books right now…", a status) and "Back to Family". The form
  itself was not walked in a browser. Read in the code and fixed: each answer draws the fields again, so the field or
  button that had the focus was gone; the answer (saved, or what went wrong) now takes the focus, and Save is
  `aria-disabled` while busy. Each field has a visible label, the browser's autofill names (`tel`,
  `address-line1`…), and the two optional ones say so.

### 7. Asking for an email change (`/family/email`, `/family/email/[token]`)

- Order: the club bar, New email, Send me a link, Back to Family. An address without "@" is stopped by the browser's
  own message, with the focus left in the field. A good one is announced ("We've sent a link to …") with the focus
  where it was.
- **Found and fixed:** pressing "Send me a link" itself (not Enter in the field) left the focus on nothing, because
  the button was disabled while busy; it is now `aria-disabled` and keeps the focus. On the link's page, a confirmed
  change replaces the form with its words, which now take the focus.
- The confirming page for the seeded link, after the journey above replaced it, says the link is no good, with Back
  to Family: words in a box, as expected.

### 8. The Display page (`/display`)

- Order: the club bar, then one Tab stop per choice group (Appearance, Contrast, Text size, Motion), then Sign out.
  The arrow keys choose within a group and the change applies at once: Dark set `data-theme="dark"`, was saved under
  `br-display` and was still applied after a reload, before paint. The focused option's ring is the mode's club text
  (lighter in dark); in forced colors it is a dashed system ring, 4px off the tile. Rings in every mode.
- Nothing found.

### 9. Paying instead of volunteering, and switching back (`/volunteer/pay-instead/[requirementId]/[choice]`)

Added after the step 6 review; read from the code and the rendered page, not yet walked in a browser (the e2e run
can't reach QuickBooks, so no buy-out is made there).

- **Found and fixed:**
  - "Confirm: invoice me $X", "Yes, cancel the invoice" and "Keep paying instead" were disabled while busy; now
    `aria-disabled`, so they keep the focus (`tests/unit/parent-busy-buttons.test.ts` holds every parent page to it).
  - "Volunteer instead" opened the question with the focus on nothing, as cancelling a sign-up once did. It now puts
    the focus on "Keep paying instead", inside a group named "Volunteer instead?", and that button gives it back.
  - A confirm or a switch-back that works redraws the page into another section, so its message ("Done. An invoice
    from the club for $25.00…", "Done. The invoice is cancelled…") vanished unheard. It now goes to a status line
    outside both sections (`Announcer`), which is announced and takes the focus.

### On a phone: the tab bar and the focus

- Walking the pages with Tab at 360 wide, a control the focus scrolled to at the foot of the screen was left partly
  under the fixed tab bar (WCAG 2.4.11): the Switch family button on Family, Pay on Payments and a form's link at the
  larger text size, and the first option of "Who will do this shift?", whose 1px hidden radio was all the browser
  scrolled into view. **Fixed:** pages with the tab bar keep 88px clear at the bottom when the focus scrolls them
  (`scroll-padding-bottom`), and a choice option's hidden radio now covers its whole tile (a base rule of
  `booster.css`). The automatic spec now walks every page with Tab and fails this.

### The frame and the pages around the journeys

- The not-found page's and the error page's "Back to the home page" and the refusal page's "Back to sign in" were
  links alone on their lines, under 44px tall: now `.link-line`. The not-found page is in the automatic spec, signed
  in and signed out.
- The automatic spec found nothing else on the parent pages: no sideways scrolling at 360 wide, no clipped or
  overlapping text at larger text size, every contrast pair passing in light, dark, both high-contrast sets and in the
  gold club color, every control named.

### For later (in `docs/ui-backlog.md` once the owner of that file adds them)

- A form's page is titled "Form" and a shift's "Sign up for a shift", which is what a screen reader hears on arriving:
  naming the form or the event would say more.
- A parent page reached by a link starts the focus at the top; a "Skip to the page" link or moving the focus to the
  page's heading would save keyboard users the club bar's six stops on every page.

### Owner's checks

- With Narrator (Windows) or VoiceOver (iPhone), walk journeys 4 and 5 and listen: the thank-you after signing up,
  "Cancel my sign-up?" on the question, the cancelled message and the check-in message should each be read once,
  and only once.
- On a real phone at the largest text size: Home, Volunteer and a form's page fit without sideways scrolling, and
  the five tabs keep their words.
