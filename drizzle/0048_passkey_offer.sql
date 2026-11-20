ALTER TABLE "parent" ADD COLUMN "passkey_offer_declines" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "parent_device" ADD COLUMN "passkey_offered_at" timestamp with time zone;