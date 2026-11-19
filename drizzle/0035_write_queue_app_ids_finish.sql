-- write queue re-key: the finish. An item is filed under the app's own family and student (0034 filled them), so the
-- family's customer column and its index go; what is sent (the request, the target, the result and the company) stays.
DROP INDEX "write_queue_family_ix";--> statement-breakpoint
ALTER TABLE "write_queue" DROP COLUMN "family_qbo_id";
