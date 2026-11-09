CREATE TABLE "auth_provider" (
	"key" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_key_id" text NOT NULL,
	"secret_expires_at" timestamp with time zone,
	"secret_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
