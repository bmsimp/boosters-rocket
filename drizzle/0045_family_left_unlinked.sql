-- Stage 4's slice M3a: the accounting links screen's "Left unlinked" mark on a family, when and by whom (staff_user.id,
-- with no foreign key, as accounting_link.linked_by has none). Additive: two nullable columns and a check that the staff
-- member is named only while the time is. It fills nothing and changes no row.
ALTER TABLE "family" ADD COLUMN "accounting_left_unlinked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "family" ADD COLUMN "accounting_left_unlinked_by" uuid;--> statement-breakpoint
ALTER TABLE "family" ADD CONSTRAINT "family_left_unlinked_by_with_at" CHECK ("family"."accounting_left_unlinked_by" is null or "family"."accounting_left_unlinked_at" is not null);
