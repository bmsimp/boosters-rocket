DROP INDEX "guardian_object_uq";--> statement-breakpoint
ALTER TABLE "guardian" ALTER COLUMN "parent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "parent_auth_user" ALTER COLUMN "parent_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_family_parent_uq" ON "guardian" USING btree ("family_qbo_id","parent_id");--> statement-breakpoint
ALTER TABLE "guardian" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "guardian" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "guardian" DROP COLUMN "phone";--> statement-breakpoint
ALTER TABLE "guardian" DROP COLUMN "identity_object_id";--> statement-breakpoint
ALTER TABLE "parent_auth_user" DROP COLUMN "object_id";