ALTER TABLE "issue" ADD COLUMN "claim_owner" text;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "claim_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "issue_claim_expiry_idx" ON "issue" USING btree ("claim_expires_at") WHERE "issue"."claim_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "issue_claim_owner_idx" ON "issue" USING btree ("claim_owner") WHERE "issue"."claim_owner" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_claim_pair_check" CHECK (("issue"."claim_owner" IS NULL AND "issue"."claim_expires_at" IS NULL)
        OR ("issue"."claim_owner" IS NOT NULL AND "issue"."claim_expires_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_claim_owner_shape_check" CHECK ("issue"."claim_owner" IS NULL
        OR ("issue"."claim_owner" = btrim("issue"."claim_owner", E' \t\r\n\f\v')
          AND length("issue"."claim_owner") > 0));--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_claim_epoch_check" CHECK ("issue"."claim_epoch" >= 0);--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_claim_active_epoch_check" CHECK ("issue"."claim_owner" IS NULL OR "issue"."claim_epoch" >= 1);
--> statement-breakpoint
CREATE FUNCTION issue_claim_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.claim_epoch < OLD.claim_epoch THEN
    RAISE EXCEPTION 'A claim epoch never decreases'
      USING ERRCODE = '23514';
  END IF;
  -- Any change of holder takes the next epoch: acquiring from nobody, releasing to
  -- nobody, and handing over to another actor all count through IS DISTINCT FROM.
  IF NEW.claim_owner IS DISTINCT FROM OLD.claim_owner THEN
    IF NEW.claim_epoch <> OLD.claim_epoch + 1 THEN
      RAISE EXCEPTION 'A change of claim owner takes exactly the next epoch'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.claim_epoch <> OLD.claim_epoch AND NEW.claim_epoch <> OLD.claim_epoch + 1 THEN
    -- Same holder: a heartbeat keeps the epoch, and a re-acquire after expiry moves it
    -- by one. Nothing else may happen to the counter.
    RAISE EXCEPTION 'A claim epoch moves by one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER issue_claim_guard
  BEFORE UPDATE ON issue
  FOR EACH ROW EXECUTE FUNCTION issue_claim_guard();
