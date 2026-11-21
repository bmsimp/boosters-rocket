# Resetting a parent's sign-in

A parent who has lost everything they sign in with can't get back in on their own. That is a parent who has lost their
phone with its passkey or authenticator app and their backup codes too, or, after the portal's address changed, one at
Strict whose only passkeys were made at the old address and who has forgotten their password (most parents a change of
address leaves stuck need only the one press of [After a change of the portal's address](#after-a-change-of-the-portals-address)).
An Admin can reset their sign-in, in the portal, on the parent's own page. Only Admins can
do this.

Most parents who are stuck don't need this:

- **Forgotten password, club at Standard.** **Set up or reset my password** on the sign-in page emails them a link to
  choose a new one.
- **Forgotten password, club at Strict.** The same page emails a link only to a parent who has a passkey or an
  authenticator app. A parent with neither who has forgotten their password needs this reset. (A parent who has never
  chosen a password needs no reset at either level: press **Resend welcome email** on their page, and it carries a
  link to choose one.)
- **Phone kept.** A parent who still has the phone or computer with their passkey or authenticator app signs in with
  it, and can change anything else under **Sign-in settings**.
- **Phone lost, backup code kept.** A backup code they haven't used works in place of their passkey or authenticator
  app: the sign-in page asks for one beside them. Once in, they can make new backup codes and set up their new phone
  under **Sign-in settings**.

## Before you reset: call them back

The reset's email goes to the parent's sign-in address, the very mailbox someone pretending to be them may hold. So the
one check that matters is made before the press, by a person:

1. Take the request, but don't act on it while the caller is on the line.
2. Find a phone number the club already holds for this parent: on their page under **Phone and mailing address**, on
   their family's page (where the club's books keep phones on the family), or in the club's own records. **Never use a
   number the caller gives you.**
3. Call them back on that number, and make sure the person you reach is the parent and that they asked for this.
4. If you can't reach them, or they didn't ask, don't reset. Tell another Admin.

## Resetting

1. Sign in as an Admin and open **Parents**, then the parent's name.
2. In **Reset sign-in**, look at what they sign in with now (a password, how many passkeys, the authenticator app,
   backup codes left, remembered phones and computers, where they are signed in). Counts only: the portal never shows
   their password or the names of their passkeys.
3. Tick **I called them back on a number the club already holds, and they asked for this**, say why in a few words
   (only staff see it: it is kept in the audit log), and press **Reset sign-in**.

The page says it is done and which address the link went to. For a parent who is blocked (unblock them first if
they should sign in again), who can't sign in to any family, or while parent sign-ins are switched off, the section says
why there is nothing to reset, and offers no press. One parent's sign-in can be reset three times a day at most.

## What the parent gets, and what they do next

At once, everywhere they were signed in, they are signed out. Their password, passkeys, authenticator app, backup codes
and remembered phones and computers are removed. Their families, forms, volunteering and everything else stay as they
are.

They are emailed a link to choose a new password ("Your <club> sign-in was reset"). It works once, for 7 days. The
email says that if they didn't ask the club for this, they should contact the club straight away, and gives the
club's treasurer's address when the club has one.

- **At Standard**, choosing the password with the link signs them in on that phone or computer; on another one they
  sign in with the password and a code emailed to them. They can then add a passkey or an authenticator app again
  under **Sign-in settings**.
- **At Strict**, once they've chosen a password, the portal asks them to add a passkey or an authenticator app before
  they see anything else, and shows them ten backup codes to keep. Choosing the password signs them in for that step
  only; so does signing in with it later, until they have added one.

## When the email couldn't be sent

The page says so: their sign-in was still reset, and they are signed out everywhere. Check outgoing mail (**Settings**,
**Outgoing mail**; the Health page's mail line says what failed). Once mail works, wait a minute, then press **Resend
welcome email** on the same page: for a parent with no password it carries a new link to choose one. (It waits a
minute after a link was made, and says so if pressed sooner.) Press it even if the parent is still owed their first
welcome email: the one the portal sends by itself would say a link was emailed earlier, and carry none. Resetting again would mail a link too, but counts towards
the three a day.

## The line on every other Admin's home page

For a week after a reset, every other Admin sees on their staff home who reset whose sign-in and when, under **Sign-in
resets this week**. The Admin who did it doesn't. This is the second check: a parent learns of a reset only from an email
to the mailbox that may not be theirs, so another Admin seeing one nobody expected is how a mistaken or false request is
caught. If you see one you didn't expect, ask whoever did it, and read their reason in the audit log (the line links to
it).

## After a change of the portal's address

A passkey belongs to the portal's address. If the address ever changes, every passkey made at the old address stops
working, though the sign-in page still asks for it and never emails a code in its place. The Health page says how
many there are, on its **Parent sign-ins** line. Remove them first, for every parent at once:

1. Make sure the portal's address (`APP_URL` in the server's env file) is the one families use now: passkeys made
   there are kept.
2. Open **Settings**, **Parent sign-ins**. The box **Passkeys from an earlier address** says how many there are, of
   how many parents, made at which addresses, and what happens to the parents who have nothing else to sign in with.
3. Press **Remove ... made at an earlier address**. If the number changed while the page was open, it says so: look at
   the new number and press again.

What each parent meets next:

- **With an authenticator app**: its code, or a backup code, as before. Their backup codes are kept.
- **With a passkey they already added at the new address**: that passkey, as before, and their backup codes.
- **With neither, club at Standard**: their backup codes go with the old passkeys, since they would stand beside
  nothing. Nobody is signed out. They sign in with their password and, on a phone or computer the portal doesn't know
  yet, a code we email, until they add a passkey again under **Sign-in settings**. A forgotten password is **Set up or
  reset my password**, as for anyone.
- **With neither, club at Strict**: their backup codes go too, and they are signed out. After their password, the
  portal asks them to add a passkey or an authenticator app before they see their family's page.

A new address also signs everyone out and leaves no phone or computer remembered, since browsers keep those sign-ins
for the old address, so a remembered phone doesn't help.

The portal emails nobody about the change. Tell your families in your own words; for example:

> Our parent portal has a new address: <the new address>. Passkeys made at the old address no longer work, so once
> you're signed in, please add yours again under Sign-in settings. Until then, sign in with your password and then
> [at Standard] the code we email you, or your authenticator app if you use one.
> [at Strict] your authenticator app if you use one; if you don't, the portal will ask you to add a passkey or an
> authenticator app first.

A parent the press doesn't bring back needs their sign-in reset, as above, each with a call back: at Strict, one with
neither who has forgotten their password, since the sign-in page emails no link to a parent with no passkey or app
there.
