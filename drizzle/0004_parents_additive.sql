CREATE TABLE "parent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent_email_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"new_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signin_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guardian" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "guardian" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "guardian" ADD COLUMN "status_before_disable" text;--> statement-breakpoint
ALTER TABLE "parent_auth_session" ADD COLUMN "family_qbo_id" text;--> statement-breakpoint
ALTER TABLE "parent_auth_user" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "parent_email_change" ADD CONSTRAINT "parent_email_change_parent_id_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signin_code" ADD CONSTRAINT "signin_code_parent_id_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "parent_email_uq" ON "parent" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "parent_email_change_token_uq" ON "parent_email_change" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "parent_email_change_one_live" ON "parent_email_change" USING btree ("parent_id") WHERE used_at IS NULL;--> statement-breakpoint
CREATE INDEX "rate_limit_event_ix" ON "rate_limit_event" USING btree ("kind","subject","at");--> statement-breakpoint
CREATE UNIQUE INDEX "signin_code_one_live" ON "signin_code" USING btree ("parent_id") WHERE used_at IS NULL;--> statement-breakpoint
ALTER TABLE "guardian" ADD CONSTRAINT "guardian_parent_id_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_auth_user" ADD CONSTRAINT "parent_auth_user_parent_id_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guardian_parent_ix" ON "guardian" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "parent_auth_user" ADD CONSTRAINT "parent_auth_user_parent_id_unique" UNIQUE("parent_id");
--> statement-breakpoint
-- Spec §5: each old guardian row becomes one person (merged by normalized email; the earliest row names them) plus its row.
INSERT INTO "parent" ("name", "email", "phone", "created_at", "updated_at")
SELECT DISTINCT ON (lower(btrim("email"))) "name", lower(btrim("email")), "phone", "created_at", "updated_at"
FROM "guardian" ORDER BY lower(btrim("email")), "created_at";
--> statement-breakpoint
UPDATE "guardian" g SET "parent_id" = p."id" FROM "parent" p WHERE p."email" = lower(btrim(g."email"));
--> statement-breakpoint
-- One row per person per family: keep the enabled one, then the primary one, then the oldest.
DELETE FROM "guardian" g USING (
  SELECT "id", row_number() OVER (PARTITION BY "family_qbo_id", "parent_id"
    ORDER BY ("status" <> 'disabled') DESC, "is_primary" DESC, "created_at") AS n
  FROM "guardian"
) d WHERE g."id" = d."id" AND d.n > 1;
--> statement-breakpoint
UPDATE "guardian" SET "disabled_reason" = 'removed', "status_before_disable" = 'invited' WHERE "status" = 'disabled';
--> statement-breakpoint
-- External ID accounts can't sign in any more; their sessions and accounts go with them (cascade).
DELETE FROM "parent_auth_user";
--> statement-breakpoint
INSERT INTO "parent_auth_user" ("id", "name", "email", "email_verified", "parent_id")
SELECT gen_random_uuid()::text, "name", "email", true, "id" FROM "parent";
--> statement-breakpoint
DELETE FROM "provider_certificate" WHERE "provider_key" = 'parent-oidc';
--> statement-breakpoint
DELETE FROM "auth_provider" WHERE "key" = 'parent-oidc';
--> statement-breakpoint
UPDATE "setting" SET "value" = jsonb_set("value", '{step}', '"mail"') WHERE "key" = 'setup.state' AND "value"->>'step' = 'parent';
