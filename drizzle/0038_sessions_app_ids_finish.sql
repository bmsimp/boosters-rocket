-- sessions re-key: the finish. A parent session names the family it chose, and a pending change of sign-in address the
-- family it was asked in, by the app's own family record (0037 filled family_id), so both QuickBooks family columns go.
-- They had no index of their own. record_qbo_id (the QuickBooks record an email change writes) stays.
ALTER TABLE "parent_auth_session" DROP COLUMN "family_qbo_id";--> statement-breakpoint
ALTER TABLE "parent_email_change" DROP COLUMN "family_qbo_id";