CREATE TABLE "qbo_relay" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"public_key" text NOT NULL,
	"private_key_ciphertext" text NOT NULL,
	"private_key_key_id" text NOT NULL,
	"key_made_at" timestamp with time zone NOT NULL,
	"key_made_by" uuid,
	"portal_id" text,
	"portal_id_saved_at" timestamp with time zone,
	"portal_id_saved_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qbo_relay_singleton" CHECK ("qbo_relay"."id" = 'singleton'),
	CONSTRAINT "qbo_relay_public_key" CHECK ("qbo_relay"."public_key" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "qbo_relay_portal_id" CHECK ("qbo_relay"."portal_id" IS NULL OR "qbo_relay"."portal_id" ~ '^brp_[a-z0-9]{16}$')
);
--> statement-breakpoint
ALTER TABLE "qbo_connection" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "qbo_connection" ALTER COLUMN "client_secret_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "qbo_connection" ALTER COLUMN "client_secret_key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "qbo_connection" ADD COLUMN "connect_mode" text DEFAULT 'relay' NOT NULL;--> statement-breakpoint
ALTER TABLE "qbo_connection" ADD COLUMN "token_mode" text;--> statement-breakpoint
ALTER TABLE "qbo_connection" ADD COLUMN "state_mode" text;--> statement-breakpoint
-- A connection made before the relay is the club's own Intuit app's: it keeps connecting, refreshing and revoking with
-- those keys (a new row defaults to the relay). A connect in progress across the upgrade was started with them too.
UPDATE "qbo_connection" SET "connect_mode" = 'own_app';--> statement-breakpoint
UPDATE "qbo_connection" SET "token_mode" = 'own_app' WHERE "refresh_token_ciphertext" IS NOT NULL;--> statement-breakpoint
UPDATE "qbo_connection" SET "state_mode" = 'own_app' WHERE "state_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "qbo_connection" ADD CONSTRAINT "qbo_connection_own_app_keys" CHECK (("qbo_connection"."connect_mode" <> 'own_app' AND "qbo_connection"."token_mode" IS DISTINCT FROM 'own_app')
    OR ("qbo_connection"."client_id" IS NOT NULL AND "qbo_connection"."client_secret_ciphertext" IS NOT NULL AND "qbo_connection"."client_secret_key_id" IS NOT NULL));