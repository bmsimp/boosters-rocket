CREATE TABLE "parent_auth_passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"aaguid" text,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "parent_auth_passkey" ADD CONSTRAINT "parent_auth_passkey_user_id_parent_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."parent_auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parent_auth_passkey_user_ix" ON "parent_auth_passkey" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parent_auth_passkey_credential_id_uq" ON "parent_auth_passkey" USING btree ("credential_id");