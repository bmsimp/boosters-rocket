# What Brian wants

The owner's taste, in his words where we have them. Read this before you touch any screen, any copy, or any flow. A design reviewer checks every PR against it. When this file and a spec disagree about how something looks or reads, ask the lead.

## 1. Pages do one job, and the job is obvious

- Every page and every step answers "what do I do here?" in the first screenful. The controls come first; any explanation comes after, and it's short.
- The one thing the page is for is the primary button. Everything else is secondary.
- A row's main action sits on the row, not inside it.

> Bad: Accounting links rows hid Confirm and Unlink inside a collapsed "Students and guardians" section, so a row showed no way to link it.
> Good: a list of families needing a link, each with one obvious button.

## 2. Actions look like actions

- Anything that starts or changes something, or moves to the next step, is a button.
- A plain link is only for reading more, going back, or opening a record.
- A button says exactly what happens, as a verb and its object.

> Bad: "Connect a different company" as underlined text under the main button; a bare "Disconnect".
> Good: **Disconnect QuickBooks**, **Link 12 customers**, **Replace this portal's key**.

## 3. Nothing hidden: no fold-outs

- No `<details>`, no "How this works", no "More".
- Forms for a row, or secondary forms, open in a **drawer**. One-press risky actions get a **confirm dialog**. Many rows at once use **bulk select**.

> Brian: "honestly I hate every fold out you put in the app. They all feel like a waste."

## 4. Few words

- One or two plain sentences for any explanation. If it needs more, it doesn't belong in the app (docs come later).
- Never paste the spec or the rules into the page. Staff need to act, not read how the code works.
- A consequence someone must know before pressing goes in one short sentence by the button.

> Brian, about the staff pages: walls of text. The QuickBooks description was about 30 lines; it's now two sentences.
> Good: "Other portals on this QuickBooks company through Boosters Rocket may be disconnected too."

## 5. Decide before, never after

- Ask the risky question before sending someone somewhere they can't easily come back from (Intuit, an email, a deletion).
- Never let a choice dead-end after the fact.

> Bad: step 2 let Brian pick the real books, sent him through Intuit, then refused because it was a different company.
> Good: step 2 asks "the same company or a different one?" first, with the switch details and the tick box right there.

## 6. Easy for a club volunteer

- Assume a busy parent volunteer, on a phone, who doesn't know QuickBooks or our terms.
- Hard parts get one clear path, not a choice of three.
- Repetitive work gets a bulk action. Linking 600 customers one row at a time isn't acceptable.
- Don't make them find hidden places. A club connected the old way sees **Move to Boosters Rocket**, not a buried step.

## 7. Material 3 Expressive, readable, and the club leads

- Follow **Material Design 3** for components, layout, interaction, states, motion and accessibility, in its **Expressive** style: bolder type, more color, rounder shapes, spring motion. (Brian, 2026-11-26; this replaces the earlier calm, Linear-like look.)
- The club's color is the seed of Material's color scheme, so every club gets its own palette. Inter stays the typeface.
- Body text 1rem or more on phones, **48×48 tap targets** (Material's minimum), WCAG AA. Expressive never at the cost of readability.
- The club's name, logo and color lead. Boosters Rocket appears only as "Powered by".
- Kind about money. Never shaming.
- Words are warm and plain, like a neighbor. US English.

## 8. Simple for clubs, even if it's more work for us

- Clubs shouldn't need accounts, apps or server skills they don't already have. That's why the shared Intuit app exists.
- Anything that sends someone to the server to type commands is a gap to close, for example in-app backups.

## 9. Keep borrowed things close to their source

- A third-party template (Tiptap's Simple Editor) is kept as its authors ship it. Our changes go in our own stylesheet and thin wrappers, so updates merge cleanly.
- Pin dependencies exactly, and add a new one only when the brief names it.

## 10. How Brian likes to work

- **See it before it's built.** For a new or redesigned screen, show a mock with the real words before writing code.
- **Real words in review.** Every PR lists each changed piece of copy: old, then new.
- **Walkthroughs:** one short step at a time, an action and how to tell it worked.
- **Explain plainly.** Say what will happen and why, without jargon. When a change is risky, say so first.
- **Autonomy within approval.** Do the work without asking at every turn, but merging, deploying, pushing to main and anything outward-facing waits for his word.
- **Fewer, bigger PRs.** Keep his desktop light on weekdays: tests run on linuxdev and in CI.

## Before you hand anything over, check

1. Can a volunteer on a phone tell what to do within five seconds?
2. Is every action a button that says what it does?
3. Is anything folded, hidden, or more than two sentences?
4. Does any choice dead-end after someone has already left the page?
5. Did you add words a staff member doesn't need in order to act?
