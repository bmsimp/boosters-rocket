ALTER TABLE "family" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "family" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "family" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "family" ADD COLUMN "address_city" text;--> statement-breakpoint
ALTER TABLE "family" ADD COLUMN "address_region" text;--> statement-breakpoint
ALTER TABLE "family" ADD COLUMN "address_postal_code" text;--> statement-breakpoint
ALTER TABLE "family" ADD COLUMN "address_country" text;--> statement-breakpoint
ALTER TABLE "family" ADD COLUMN "contact_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "address_city" text;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "address_region" text;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "address_postal_code" text;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "address_country" text;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "contact_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "qbo_customer" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "qbo_customer" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "qbo_customer" ADD COLUMN "address_city" text;--> statement-breakpoint
ALTER TABLE "qbo_customer" ADD COLUMN "address_region" text;--> statement-breakpoint
ALTER TABLE "qbo_customer" ADD COLUMN "address_postal_code" text;--> statement-breakpoint
ALTER TABLE "qbo_customer" ADD COLUMN "address_country" text;--> statement-breakpoint
-- contact details: by hand. A guardian's phone and mailing address become the portal's own (stage 3's slice 11a of the
-- app-owned families spec, open question 6): on the person in books with a parent type, on the family in books with
-- none. This fills nothing: the roster cache held no address before this migration, and the rule that says whose
-- QuickBooks record is whose (fieldSignsIn() over the email field) is the code's, not restated here. The phones
-- parent.phone holds were copied by migration 0004 from the guardian rows of that time and read by nothing since, so
-- they are cleared, and the take-in (src/lib/parents/contact-take-in.ts) gives each person and family the details their
-- own record holds, once, after the first successful roster read that starts after this migration: asked for here as a
-- parent's confirmed email change asks for one (src/lib/parents/refresh-ask.ts), and the take-in's own setting records
-- the time it must start after. The read must be one that keeps the billing address, which marks the setting itself
-- (`addressesReadAt`): the build before this one answers the same ask while it still runs. Refuses nothing.
INSERT INTO "setting" ("key", "value")
  VALUES ('roster.refresh_asked', jsonb_build_object('at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
  ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = now();
--> statement-breakpoint
INSERT INTO "setting" ("key", "value")
  VALUES ('parents.contact_take_in', jsonb_build_object('after', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
  ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = now();
--> statement-breakpoint
WITH cleared AS (
  UPDATE "parent" SET "phone" = NULL WHERE "phone" IS NOT NULL RETURNING 1
)
INSERT INTO "audit_log" ("door", "actor_label", "action", "target_type", "after")
  SELECT 'system', 'migration', 'parent.details.migrated', 'parent', jsonb_build_object('cause', 'migration 0044_contact_details_additive',
    'phonesCleared', (SELECT count(*) FROM cleared));
