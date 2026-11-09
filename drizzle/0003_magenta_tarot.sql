CREATE TABLE "provider_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_key" text NOT NULL,
	"status" text NOT NULL,
	"certificate_pem" text NOT NULL,
	"thumbprint_s256" text NOT NULL,
	"thumbprint_sha1" text NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"private_key_ciphertext" text,
	"private_key_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_provider" ALTER COLUMN "secret_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_provider" ALTER COLUMN "secret_key_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_certificate_one_pending" ON "provider_certificate" USING btree ("provider_key") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "provider_certificate_one_active" ON "provider_certificate" USING btree ("provider_key") WHERE status = 'active';