CREATE TABLE "parent_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent_signin_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"parent_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "parent_auth_session" ADD COLUMN "strong_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "parent_device" ADD CONSTRAINT "parent_device_parent_id_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_signin_token" ADD CONSTRAINT "parent_signin_token_parent_id_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "parent_device_token_uq" ON "parent_device" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "parent_device_parent_ix" ON "parent_device" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parent_signin_token_one_live_uq" ON "parent_signin_token" USING btree ("parent_id","purpose") WHERE used_at IS NULL;--> statement-breakpoint
CREATE INDEX "parent_signin_token_hash_ix" ON "parent_signin_token" USING btree ("token_hash");