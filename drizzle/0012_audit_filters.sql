CREATE INDEX "audit_action_ix" ON "audit_log" USING btree ("action","id");--> statement-breakpoint
CREATE INDEX "audit_actor_ix" ON "audit_log" USING btree ("actor_id","id");--> statement-breakpoint
CREATE INDEX "audit_target_ix" ON "audit_log" USING btree ("target_type","target_id","id");