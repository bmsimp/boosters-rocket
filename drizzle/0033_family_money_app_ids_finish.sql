-- money cache re-key: the finish. A family's stored figures are kept by the app's own family alone (0032 filled it), so
-- family_id becomes the key and family_qbo_id goes; the company, the invoices with their customers and the check stay.
-- Written by hand where drizzle-kit would add the new primary key before the old one is gone: the old key is dropped
-- first, then the new one made under the same name (family_money_pkey), which also makes the unique index redundant.
ALTER TABLE "family_money" ALTER COLUMN "family_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "family_money" DROP CONSTRAINT "family_money_pkey";--> statement-breakpoint
ALTER TABLE "family_money" ADD CONSTRAINT "family_money_pkey" PRIMARY KEY ("family_id");--> statement-breakpoint
DROP INDEX "family_money_family_id_uq";--> statement-breakpoint
ALTER TABLE "family_money" DROP COLUMN "family_qbo_id";
