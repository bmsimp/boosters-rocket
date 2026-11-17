# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Responsive web app. Parents mostly use phones; staff mostly use laptops. A parent can also install the
portal as an app on an iPhone or Android phone, from the browser; it is the same web app.

## Stack

Next.js (TypeScript), Postgres, Docker image per release. Self-hosted Documenso for
e-signatures. Chosen by the project owner. Full architecture in
`docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md`.

## Users

- **Parents and guardians** (primary). Non-technical, every age, often on an older phone, often
  in a hurry: in a car-pickup line, at a game, after a reminder email. They come to check what
  they owe, pay an invoice, sign this season's commitment forms for each of their students, sign
  up for a volunteer shift and check in at it, or update a phone number, address or sign-in email.
  They visit a handful of times a season.
- **Staff**: board members, roster volunteers, band directors. Usually on a laptop, sometimes for
  an hour at a time at the start of a season. They manage families and students, set up seasonal
  forms and chase unsigned ones, check balances and the reconciliation report, and manage who can
  do what.
- **Students** never sign in. They appear only as records on their family.

## Product Purpose

An open-source parent portal for booster clubs and other parent groups that support youth
programs. It gives each family one private place to see their students, what they owe, and what
they still need to sign, and gives volunteers one place to manage the roster and forms, while the
club's books stay in QuickBooks Online.

Success: a parent signs in, sees only their own family, pays an open invoice and signs their
forms without needing help; a volunteer can tell at a glance who still owes forms or money.

## Positioning

Free, open-source and self-hosted by each club, built around QuickBooks Online as the system of
record rather than replacing the club's accounting. Commercial booster platforms (for example
BoosterHub, and Charms, which is being retired) are paid services that hold the club's data
themselves.

## Operating Context

- Every club runs its own copy and rebrands it with its own name, short name and color (a logo
  can't be supplied yet). The first club to use it is meant to be FZN Band Boosters, at
  `portal.fznband.org`; it isn't installed there yet.
- Money: invoices are raised in QuickBooks. Parents pay on QuickBooks' own hosted payment page,
  reached from a "Pay" button on each invoice.
- Signatures: forms are signed inside the portal through embedded Documenso signing.
- Parents sign in with a one-time code that the portal emails them; staff sign in with Microsoft
  or Google.
- The work is seasonal: a heavy burst at the start of each season (forms, new families), then
  occasional balance checks and payments.
- One volunteer maintains each club's copy, and a successor may not code.

## Capabilities and Constraints

- v1: sign-in, family roster stored in QuickBooks, balances and open invoices with pay links,
  parent contact edits, seasonal commitment forms with signature tracking, admin-configured season
  steps holding requirements (forms, payments, volunteering, checklist items), volunteer sign-up
  with shifts, self check-in and paid buy-outs, staff permissions, and an audit log.
- Not v1: messaging, a general events calendar, volunteer waitlists, inventory, medical forms,
  student logins.
- Many clubs require volunteering per family or per student; requirements must be configurable,
  never hard-coded.
- One family must never see another family's data; public pages show no family data at all.
- Terminology: **family** (a QuickBooks customer), **student** (a sub-customer), **guardian**
  (a person who signs in for a family), **staff**, **season**, **form**.
- Theming: each club supplies its name, short name and color at runtime, without a code change or
  rebuild. A logo is to follow the same way; it isn't built yet.

## Brand Commitments

- Product name: **Booster Rocket**. Each club's own name and logo lead in the parent-facing app;
  Booster Rocket is credited, not featured.
- FZN has no fixed brand assets. The default theme must work for any club and must stay legible
  and accessible whatever logo and colors a club supplies.
- Voice: a warm, plain-spoken neighbor. Short sentences and everyday words. Never scolding or
  alarming about money ("You have 2 forms left for Maya", not "Action required: overdue").

## Evidence on Hand

No screenshots, testimonials, customer quotes or usage numbers exist yet. Do not invent any.

## Product Principles

1. **A parent never needs help.** Every parent task can be finished on a phone, alone, the first
   time.
2. **Their family, only.** The interface never hints at other families' existence to a parent.
3. **QuickBooks is the truth.** The portal shows when figures were last read and never pretends
   to hold its own version of the books.
4. **The club, not the software.** Each club's identity leads; the product stays out of the way.
5. **Kind about money.** Balances are stated plainly and calmly, with the next step one tap away.

## Accessibility & Inclusion

WCAG 2.2 AA. A wide age range of users on older phones means tap targets, contrast and readable
text sizes matter in practice, and a club's chosen colors must never break contrast.
