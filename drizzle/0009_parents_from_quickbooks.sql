CREATE TABLE "family_match" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"old_realm_id" text NOT NULL,
	"old_family_qbo_id" text NOT NULL,
	"new_realm_id" text NOT NULL,
	"new_family_qbo_id" text NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "held_address" (
	"email" text PRIMARY KEY NOT NULL,
	"approved_family_qbo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejected_family_qbo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"announced_family_qbo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guardian" ADD COLUMN "source_qbo_id" text;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "blocked_by" uuid;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "welcomed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "welcome_owed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "parent" ADD COLUMN "welcome_tried_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "family_match_old_uq" ON "family_match" USING btree ("old_realm_id","old_family_qbo_id");