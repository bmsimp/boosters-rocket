# Documenso: forms, and the signing certificate

Parents sign the club's forms inside the portal, in a Documenso the club runs itself (the `documenso` service in
`deploy/compose.yml`, at the address in `DOCUMENSO_URL`). This runbook makes its signing certificate, its first
account, and connects it to the portal. Documenso's own documentation is at https://docs.documenso.com.

The commands run in `~/booster-rocket/deploy`. Where they say `docker compose`, add the `-f` files and `--profile` you
start the installation with (for example `docker compose --profile proxy`).

## 1. Make the signing certificate

Documenso seals every signed form with this certificate, so a changed PDF can be told from the one that was signed.
A certificate the club makes itself is enough for that. PDF readers will say the signer "isn't trusted", because they
don't know the club; the signature is still valid and the document unchanged. (A certificate from a certificate
authority shows as trusted; Documenso's documentation, "Signing certificate", says how to convert one.)

1. Make a passphrase and keep it in the board's password manager:
   ```bash
   openssl rand -hex 24
   ```
2. Make the certificate, valid for three years. Type the passphrase when asked (it isn't shown):
   ```bash
   cd /srv/booster-rocket
   umask 077
   openssl genrsa -out signing.key 2048
   openssl req -new -x509 -key signing.key -out signing.crt -days 1095 -subj "/O=<the club's name>/CN=<the club's name> forms"
   read -s -p "Passphrase: " CERT_PASS; echo; export CERT_PASS
   openssl pkcs12 -export -out documenso-signing.p12 -inkey signing.key -in signing.crt -password env:CERT_PASS
   unset CERT_PASS
   rm signing.key signing.crt
   ```
   A certificate without a passphrase makes signing fail, so never leave it empty.
3. Keep a copy of `documenso-signing.p12` with its passphrase, together, somewhere safe that is not this machine,
   now, while the file is still yours to read (the next step hands it to Documenso). The nightly backup doesn't copy
   it.
4. Let Documenso read it. Documenso runs as the user number 1001:
   ```bash
   sudo chown 1001 documenso-signing.p12
   sudo chmod 400 documenso-signing.p12
   ```
   From now on only Documenso (and `sudo`) can read the file here: a later copy needs `sudo cp`, and the copy then
   needs `sudo chown "$USER"` before you can move it anywhere.
5. In `deploy/.env`: `DOCUMENSO_SIGNING_CERTIFICATE=/srv/booster-rocket/documenso-signing.p12` and
   `DOCUMENSO_SIGNING_PASSPHRASE=<the passphrase>`.
6. Write the date it expires (three years from today) where the board will see it, with a reminder a month before.

### Renewing it

Forms already sealed keep their signature: renewing changes nothing in them.

1. Make a new certificate as in steps 1 to 4, under a new name (`documenso-signing-<year>.p12`), keeping its copy
   (step 3) before handing it to Documenso (step 4).
2. Put the new name and passphrase in `deploy/.env`, then `docker compose up -d documenso`.
3. Check `<DOCUMENSO_URL>/api/health`: it says `"certificate":{"status":"ok"}`.
4. Keep the old file and passphrase too, with a note of the dates they were in use.

## 2. The first Documenso account

The forms account belongs to the club, not to a person: the portal's API token and the webhook hang on it, and they
stop working if it is removed. Use a club mailbox (for example `forms@example.org`). Documenso's account mail must
work first ([outgoing mail](mail.md#documensos-account-mail)).

1. Open sign-up for a few minutes: in `deploy/.env`, set `DOCUMENSO_DISABLE_SIGNUP=false`, then
   `docker compose up -d documenso` and wait until `docker compose ps` says it is `healthy`.
2. Open `<DOCUMENSO_URL>/signup` and make the account with the club mailbox and a long password (keep it in the
   password manager).
3. Open the confirmation email and select its link.
4. Close sign-up again: `DOCUMENSO_DISABLE_SIGNUP=true` in `deploy/.env`, then `docker compose up -d documenso`.
5. Check that it is closed: `<DOCUMENSO_URL>/signup` now goes straight to the sign-in page.
6. Make the account Documenso's administrator (there is no screen for the first one):
   ```bash
   docker compose exec db psql -U postgres -d documenso -c "update \"User\" set roles = array_append(roles, 'ADMIN') where email = '<the club mailbox>' and not 'ADMIN' = any(roles)"
   ```
   It answers `UPDATE 1`. Sign out of Documenso and in again to see **Admin**.
7. Optional: under **Admin**, **Organisations**, the club's organisation, tick **Hide Documenso branding** and
   **White label for embed signing**.
8. Make an organisation for the club, and a team in it (for example "Forms"). Invite the staff who will make forms to
   the organisation; they get an email and make their own accounts from it, so sign-up can stay closed.

### Staff sign-in to Documenso with the club's own sign-in (optional)

Documenso can let staff sign in with the club's Microsoft or Google accounts through OpenID Connect. Register an app
for it as Documenso's documentation says ("Authentication", OIDC), with the redirect address it gives, then set the
`DOCUMENSO_OIDC_*` lines in `deploy/.env` and `docker compose up -d documenso`. For Microsoft, set
`DOCUMENSO_OIDC_SKIP_VERIFY=true` (Microsoft doesn't say whether an address is verified). Documenso links a sign-in
to an account by its email address, so only use a directory where nobody can choose someone else's address.

## 3. Connect Documenso to the portal

1. In Documenso, signed in as the forms account, open the team's settings, **API Tokens**, and create a token that
   doesn't expire. Copy it.
2. In the portal, as an Admin: **Settings**, **Forms (Documenso)**, **Set up**. In step 1, enter Documenso's address
   exactly as `DOCUMENSO_URL` in `deploy/.env` (same name, `https`, no port unless it has one) and paste the token.
   **Save**.
3. Step 2, **Check the connection**. It asks Documenso whether it is healthy, then makes one call with the token.
4. Step 3, **Make the secret**, and copy it (it is shown once), and copy the **Webhook URL** the page shows.
5. In Documenso, the team's settings, **Webhooks**, add a webhook: paste the address and the secret, and tick every
   document event. Save.
6. If the portal's address resolves to a private address from the server (a portal reachable only on the club's own
   network), Documenso refuses to send there: set `DOCUMENSO_WEBHOOK_PRIVATE_HOSTS=<the portal's host name>` in
   `deploy/.env` and `docker compose up -d documenso`. Otherwise leave it empty.
7. Open **Health**: **Forms (Documenso)** says "Connected". After the first form is signed, its **Last webhook** time
   appears. (A webhook that never arrives only slows things: the worker asks Documenso about every open form every few
   minutes.)

## 4. The first form

1. In Documenso, make the form as a template, with one signer role per guardian and read-only text fields labelled
   "Student name" (or "Family name"), "Guardian 1 name" and "Guardian 2 name".
2. In the portal, under **Season**, **Seasons**, add a requirement of the kind **Form** and attach the template on its
   page. The portal checks the template and says what to change if it can't be used.
3. Sign it once yourself as a test parent, and open the signed PDF.
4. Before forms go live, have the club's lawyer read the words parents agree to before they sign (shown on a form's
   page above **I agree to sign electronically**) and one sealed form with its certificate page and audit log
   ([before the first family, part 4](before-the-first-family.md#4-documenso-and-entra-a-full-installation)).

## Trusted time on signatures (a decision for the club)

By default a signature's time comes from this server's clock (`DOCUMENSO_TIMESTAMP_AUTHORITY` empty), and sealing a
form needs nothing outside this machine. With a timestamp service's address there, each signature carries a time PDF
readers can trust, a hash of every document is sent to that service, and sealing waits for it: if it is down for more
than six hours, signed forms stay unsealed until staff ask again. The club's owner hasn't chosen yet. Changing it later
affects only forms sealed afterwards.

## Updating Documenso

The portal was checked against one version of Documenso (`deploy/compose.yml` names it). A dependency update that
moves it is a pull request: read Documenso's release notes for every version in between before merging it, then follow
[updates](updates.md), and afterwards sign a test form and check the Health page's forms line. Documenso updates its own
database when it starts, and can't be moved back except by a restore.
