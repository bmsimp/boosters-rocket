# Booster Rocket

An open-source parent portal for booster clubs and other parent groups that support youth
programs.

Parents sign in, see their own students and what their family owes, pay open invoices, keep their
contact details current, and sign each season's commitment forms. Volunteers manage the family
roster and forms from the same app.

- **QuickBooks Online is the source of truth** for invoices, payments and the family roster. The
  portal reads from it and writes roster and contact changes back to it.
- **Commitment forms are signed in [Documenso](https://github.com/documenso/documenso)**, which
  each club self-hosts alongside the portal.
- **Each club runs its own copy.** There is no shared, multi-club service.

**Status:** design. Start with [the v1 design](docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md).

Licensed under [AGPL-3.0](LICENSE).
