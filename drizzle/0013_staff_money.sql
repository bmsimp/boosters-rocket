CREATE TABLE "qbo_item" (
	"qbo_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text,
	"active" boolean NOT NULL,
	"realm_id" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_money" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "family_money" ADD COLUMN "customer_checks" jsonb;--> statement-breakpoint
ALTER TABLE "requirement" ADD COLUMN "item_qbo_id" text;