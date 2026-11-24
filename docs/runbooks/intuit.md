# Intuit: connecting QuickBooks, through Boosters Rocket or the club's own app

The portal reads the club's families and invoices from QuickBooks Online, and writes back only what someone asks it to
(a guardian's phone and mailing address, changed by the parent or by staff; the roster
changes staff make; and the invoice for a volunteer buy-out, made when a guardian chooses to pay instead of
volunteering and voided if they switch back before paying). A guardian's phone and mailing address are the portal's
own, kept and changed there, and each change is sent on to their record in QuickBooks after it is saved.

There are two ways for the portal to reach QuickBooks. Step 1 of the QuickBooks steps, **How to connect**, offers both:

- **Connect through Boosters Rocket** (the usual way, and the one a new portal starts on): the portal connects through
  Boosters Rocket Connect, one Intuit app that Intuit has already approved for real books. The club registers its portal
  once, by email, and needs no Intuit app or assessment of its own. Start at
  [Connect through Boosters Rocket](#connect-through-boosters-rocket).
- **Use our own Intuit app**: the club registers an app with Intuit itself and passes Intuit's production assessment,
  which can take weeks, before it can read its real books. Parts 1 to 4 below walk it. It is the fallback, and for a club
  that prefers to hold its own app.

Intuit's screens change. Where one doesn't match these steps, trust the screen; the developer site's own help is at
https://developer.intuit.com.

## Connect through Boosters Rocket

Boosters Rocket Connect is at `https://connect.boostersrocket.app` unless whoever installed the portal set
`QBO_RELAY_URL` in `deploy/.env` to another (a fork running its own). The QuickBooks page shows the address it uses.
Its tokens travel only between the portal's server and Boosters Rocket's, never through a browser's address bar.

1. **Register the portal.** As an Admin: **Settings**, **QuickBooks**, **Set up** (or **Change**). In step 1, **How to
   connect**, keep **Connect through Boosters Rocket** chosen (a club moving from its own app chooses it and selects
   **Save this choice**). The stage reads **Not registered yet**: select **Make this portal's key**. The private half of
   the key never leaves the server.
2. The stage reads **Waiting for the id**, with the portal's address and its public key, each with a Copy button. Select
   **Write the email** (or copy both into an email of your own) and send them to support@boostersrocket.com. The
   portal's address must start with `https://`; if it doesn't, the step says so and whoever installed the portal sets
   `APP_URL`.
3. Boosters Rocket registers the portal and emails back its id, `brp_` and 16 letters or digits. Paste it into
   **Portal id** and select **Save the portal id**. The portal asks Boosters Rocket at once: "Registered as" the club's
   name, with which QuickBooks it may connect, is right. If it says the id and the key don't match, check the id
   against the email, then email support@boostersrocket.com. If Boosters Rocket couldn't be reached, select **Check
   again** later. The stage reads **Ready to connect**.
4. **Connect.** Open step 2. Under **Which QuickBooks**, choose **The club's real books**, or **An Intuit sandbox (test)
   company** for a trial (a sandbox is best tried on the proof-of-concept host, as part 2 says). Select **Connect to
   QuickBooks**. At Intuit, sign in as an admin of the club's company, choose it and approve Boosters Rocket Connect. You
   come back to the portal at step 3.
5. Choose the membership shape (**Layered** or **Flat**, as part 2 describes), **Preview**, check, **Save this shape**.
6. Open **Health**: **QuickBooks** says "Connected" to the club's company "through Boosters Rocket", and the **Boosters
   Rocket Connect** line says it answered.

A club that connected with its own Intuit app moves over the same way: choose **Connect through Boosters Rocket**,
register, and **Connect to QuickBooks** to the same company. That is not a change of company: nothing in the portal
changes, and once the new connection is stored the portal asks Intuit to end the old app's access. If Intuit doesn't
confirm, step 3 says so, and an admin of the company can disconnect the old app in QuickBooks' Apps list.

**Disconnecting** through Boosters Rocket: every portal connected to one QuickBooks company through it shares one
connection, so disconnecting one (say, a trial copy of the portal) may disconnect the others, the club's real portal
included. **Disconnect** says so, and asks you to tick that you understand before **Disconnect QuickBooks** works.
Going back to the club's own app from Boosters Rocket needs a Disconnect first.

The rest of this runbook, parts 1 to 4, is for **Use our own Intuit app** only.

## 1. Register the app

1. Go to https://developer.intuit.com and sign in, or create an Intuit developer account, with an address that belongs
   to the club rather than to one person (a board mailbox), so the app outlives anyone's term.
2. Open the **Dashboard** and create an app for **QuickBooks Online and Payments**. Name it after the club, for
   example "Example Boosters portal".
3. When asked for permissions (scopes), choose **Accounting** only (`com.intuit.quickbooks.accounting`). The portal
   needs nothing else.
4. Open the app's **Keys and credentials** (or **Development settings**). Note the **Client ID** and **Client secret**
   of the Development keys. Treat the secret like a password: paste it only into the portal.
5. The redirect address is on another page: the app's **Settings**, **Redirect URIs**. Under **Development**, add
   exactly:
   ```
   <APP_URL>/api/quickbooks/callback
   ```
   with the portal's address from `deploy/.env` (for example `https://portal.example.org/api/quickbooks/callback`).
   No trailing slash.

## 2. Try it on a sandbox company first

Do this on the proof-of-concept host, or another installation of its own, if you can: it is still the better place.
A trial on the installation families will use can now be followed by the club's real books, as a switch of company,
but the switch ends every link made to the sandbox's customers, and the trial's ended buy-outs and audit rows stay
behind ([reconnecting QuickBooks](quickbooks-reconnect.md#connecting-a-different-company)).

1. On the developer site, open **Sandbox** and create a sandbox company if there is none.
2. In the sandbox, set the company up like the club's books: the customer types the club uses (for example Family,
   Student and Parent), with students and parents as sub-customers of a family, and a few invoices.
3. In the portal, as an Admin: **Settings**, **QuickBooks**, **Set up**.
4. In step 1, choose **Use our own Intuit app**. Enter the Development **Client ID** and **Client secret**, choose
   **Sandbox**, **Save**, then **Next: sign in to Intuit** in the note that appears.
5. **Connect to QuickBooks**, sign in to Intuit, choose the sandbox company and **Connect**. You come back to the portal.
6. Choose the membership shape (**Layered** when families have students and parents under them; **Flat** when each
   member is a customer of their own) and the customer types, select **Preview**, check the counts and names, then
   **Save this shape**.
7. Open **Roster** in the staff menu: its counts line has the counts QuickBooks has. Its families are the portal's
   own: a read of QuickBooks brings no customer into them, so a fresh installation lists none at first. Open
   **Accounting links** (under **Families**): **Customers with no family** lists each active family customer QuickBooks
   has at the top level (under no other customer) that no family in the portal is linked to (an inactive one isn't
   offered). **Propose families from the books** proposes a family for each, up to 25 at a time, with its students and
   guardians, to look over and save with **Make these families**; **Create a family from this** brings one in, with its
   students, and no guardian. Neither sends anything to QuickBooks. **Health** says QuickBooks is "Connected" and names the company as a sandbox.
8. Check the portal's requests: **Settings**, **QuickBooks**, **Check the portal's requests**, **Run the check**. In a
   sandbox company it tries every request the portal makes, on a few test records of its own, and says for each
   whether QuickBooks answered as the portal expects. [Before the first family](before-the-first-family.md#2-check-the-portals-requests-in-the-intuit-sandbox)
   says what to do with what it finds.

## 3. The production assessment

1. On the developer site, open the app's **Production settings** (or **Keys and credentials**, **Production**).
2. Fill in what Intuit asks about the app. The portal's own pages answer most of it:
   - the app's address: the portal's `APP_URL`;
   - the production redirect address: `<APP_URL>/api/quickbooks/callback`, as in part 1;
   - the end-user licence: the portal is open source under the AGPL-3.0 (the `LICENSE` file in the repository); the
     club may want its own terms of use page as well;
   - a privacy policy: the club's own, saying the portal keeps a copy of the club's customer list and open invoices to
     show each family its own, and changes in QuickBooks only what a parent or staff member asks it to.
3. Answer the assessment questionnaire. It asks how the app uses QuickBooks data and keeps it safe. True answers for
   the portal: it runs on the club's own server; it stores the connection's tokens encrypted; families see only their
   own records; it reads customers, invoices and items; it writes a guardian's phone and mailing address
   after the portal saves a change to them, the roster changes staff make, and one kind of invoice, a volunteer buy-out, which it creates
   when a guardian chooses it and voids if they switch back before paying; it never deletes anything or touches a
   payment; it keeps an audit log of every change. It finds Intuit's OAuth endpoints (sign-in, token and revoke) in Intuit's
   discovery document (`https://developer.api.intuit.com/.well-known/openid_configuration`, and
   `openid_sandbox_configuration` for a sandbox company), kept for a day; if that can't be read, or names an address
   that isn't https on an Intuit address, it uses the endpoints it was built with and logs that it did. When Intuit refuses a
   request, it keeps Intuit's `intuit_tid` with the failure and shows it to staff as "Intuit reference", for Intuit
   support.
4. Submit it, and answer Intuit's follow-up questions by email.
5. When Intuit approves the app, the **Production** **Client ID** and **Client secret** appear.

## 4. Connect the club's real books

On the installation families will use, the real books are best the first company it connects. One that has already
read a sandbox company's customers takes them only as a switch: an Admin selects **Connect a different company** first,
and every family is then linked to the real books' customers again on Accounting links
([reconnecting QuickBooks](quickbooks-reconnect.md#connecting-a-different-company)). Without that, it says the company
isn't the one the portal's families were read from, and changes nothing. Keep the sandbox trial on the
proof-of-concept host where you can, and install the club's own from [first install](first-install.md).

1. In the portal: **Settings**, **QuickBooks**. With no keys saved yet the button is Set up; with Development keys saved
   from a try, and nothing ever connected, it is **Change**, and its steps open at step 1, where the keys go.
2. Enter the Production keys, **Production**, then in step 2 **Connect to QuickBooks**, sign in to Intuit with an
   account that can open the club's company, choose it and **Connect**.
3. Choose the membership shape, **Preview**, check, **Save this shape**.
4. Open **Health**: QuickBooks says "Connected" to the club's company "with the club's own Intuit app", with no word of
   a sandbox.
