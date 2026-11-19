# Outgoing mail

Two things send mail, and each is set up on its own:

- **The portal** sends parents their password links and sign-in codes, welcome emails, reminders and signed copies of forms. It is set up
  on the portal's setup page (Step 3) and later under **Settings**, **Outgoing mail**. Parents can't sign in until it
  works.
- **Documenso** sends only its own account mail: the confirmation of the first account, password resets and
  invitations to staff. It sends nothing about forms (the portal switches that off on every form). It is set up in
  `deploy/.env`.

Both can use the same mailbox. Choose a mailbox that belongs to the club, not to one person (for example
`boosters@example.org`).

## The portal: Microsoft 365

The portal sends through Microsoft 365 as one mailbox, using the staff sign-in app's certificate, and Exchange Online
lets it send as that mailbox and no other. It needs staff sign-in with Microsoft to be set up first (setup Step 2).

1. On a Windows computer with PowerShell 7, install the modules the script needs once:
   `Install-Module Microsoft.Graph.Authentication, ExchangeOnlineManagement -Scope CurrentUser`
2. On the setup page's Step 3 (or **Settings**, **Outgoing mail**, **Set up** or **Change**), the first box, **Let
   Microsoft 365 send for the portal**, holds the numbered steps under **Microsoft 365: let the app send as one
   mailbox**. They have you download the script `New-BoosterRocketStaffApp.ps1`, unblock it
   (`Unblock-File .\New-BoosterRocketStaffApp.ps1`) and run it with `-SetUpMail -Mailbox <the club's mailbox>`, signed
   in as an Exchange administrator. The page writes the command out with the club's tenant and mailbox in it.
3. The script stops and says what to change if anything would let the app send as more than that one mailbox. Do what
   it says and run it again.
4. When it ends with "The app can now send as ... and only as ...", wait 30 minutes to 2 hours: Microsoft takes that
   long to apply app permissions.
5. In **Choose how the portal sends**, choose **Microsoft 365**, enter the mailbox and **Save**; then in **Send a test
   email**, **Send test email** to an address you can read. When it arrives, the setup page's next step opens.

## The portal: SMTP

Any mail service that offers SMTP works. You need its server name, port, a username and password, and the address mail
comes from. The mail service's own help pages give the first two.

1. On the setup page's Step 3 (or **Settings**, **Outgoing mail**, **Set up** or **Change**), in **Choose how the
   portal sends**, choose **SMTP**.
2. Enter the **Host** and **Port**, and choose **Security**: **STARTTLS** for port 587, **TLS** for port 465. The
   portal never sends without encryption.
3. Enter the **Username**, **Password** and **From address**. Many services need the from address to be the account's
   own, or one they have verified.
4. **Save**, then **Send test email** to an address you can read. Look in the spam folder too.
5. If the test fails, the page says why in words. The usual causes: the wrong port for the security chosen, a password
   the service wants made specially for apps, or a from address the service won't send as.

## Documenso's account mail

Set these lines of `deploy/.env`, then `docker compose up -d documenso` (with the same `-f` files and `--profile` you
start with):

| Line | Microsoft 365 | Another SMTP service |
|---|---|---|
| `DOCUMENSO_SMTP_HOST` | `smtp.office365.com` | the service's SMTP server |
| `DOCUMENSO_SMTP_PORT` | `587` | `587`, or `465` |
| `DOCUMENSO_SMTP_SECURE` | `false` (it starts TLS on 587) | `false` for 587, `true` for 465 |
| `DOCUMENSO_SMTP_USERNAME` | the mailbox's address | the account's username |
| `DOCUMENSO_SMTP_PASSWORD` | the mailbox's password | the account's password |
| `DOCUMENSO_SMTP_FROM_ADDRESS` | the same mailbox | an address the service sends as |
| `DOCUMENSO_SMTP_FROM_NAME` | for example `Example Boosters forms` | the same |

For Microsoft 365 the mailbox needs **Authenticated SMTP** turned on (the Microsoft 365 admin center, **Users**, the
mailbox, **Mail**, **Manage email apps**). Some organisations switch SMTP sign-in with a password off for everyone; if
yours has, use another SMTP service for Documenso. It sends only a few messages a year.

To check it, use Documenso's **Forgot password** with the forms account's address: the reset email arrives. If not,
`docker compose logs documenso` shows the mail error.
