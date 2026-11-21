-- Stage 4's slice M4b: a family's sign-ins held, when and by whom (staff_user.id, with no foreign key, as
-- accounting_left_unlinked_by has none), after a take from the books on the accounting links screen made the family, or
-- a student who opens it, active again. The gate reads it: while it is set, no guardian of the family signs in to it,
-- until someone who may change families lets them in on its page. Additive: two nullable columns and a check that the
-- staff member is named only while the time is. It fills nothing and changes no row. Numbered after S12b1's 0048; it may
-- be renumbered when the branches are merged.
ALTER TABLE "family" ADD COLUMN "signin_held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "family" ADD COLUMN "signin_held_by" uuid;--> statement-breakpoint
ALTER TABLE "family" ADD CONSTRAINT "family_signin_held_by_with_at" CHECK ("family"."signin_held_by" is null or "family"."signin_held_at" is not null);
