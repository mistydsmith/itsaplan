CREATE TABLE "bead_identity" (
	"id" serial PRIMARY KEY NOT NULL,
	"rig_id" integer NOT NULL,
	"local_token" text NOT NULL,
	"root" integer,
	"child" integer,
	"origin" text NOT NULL,
	"issue_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bead_identity_rig_token_uq" UNIQUE("rig_id","local_token"),
	CONSTRAINT "bead_identity_origin_check" CHECK ("bead_identity"."origin" IN ('minted', 'imported')),
	CONSTRAINT "bead_identity_local_token_check" CHECK ("bead_identity"."local_token" ~ '^[^[:space:]]+$'),
	CONSTRAINT "bead_identity_minted_token_check" CHECK ("bead_identity"."origin" = 'imported' OR (
        "bead_identity"."origin" = 'minted'
        AND "bead_identity"."root" IS NOT NULL AND "bead_identity"."root" >= 1
        AND "bead_identity"."child" IS NOT NULL AND "bead_identity"."child" >= 0
        AND "bead_identity"."local_token" = "bead_identity"."root"::text
          || CASE WHEN "bead_identity"."child" = 0 THEN '' ELSE '.' || "bead_identity"."child"::text END
      ))
);
--> statement-breakpoint
CREATE TABLE "rig" (
	"id" serial PRIMARY KEY NOT NULL,
	"prefix" text NOT NULL,
	"next_root" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rig_prefix_unique" UNIQUE("prefix"),
	CONSTRAINT "rig_prefix_check" CHECK ("rig"."prefix" ~ '^[^[:space:]]+$'),
	CONSTRAINT "rig_next_root_check" CHECK ("rig"."next_root" >= 1)
);
--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "bead_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "rig_id" integer;--> statement-breakpoint
ALTER TABLE "bead_identity" ADD CONSTRAINT "bead_identity_rig_id_rig_id_fk" FOREIGN KEY ("rig_id") REFERENCES "public"."rig"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bead_identity" ADD CONSTRAINT "bead_identity_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bead_identity_rig_numeric_uq" ON "bead_identity" USING btree ("rig_id","root","child") WHERE "bead_identity"."root" IS NOT NULL AND "bead_identity"."child" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bead_identity_issue_uq" ON "bead_identity" USING btree ("issue_id") WHERE "bead_identity"."issue_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_rig_id_rig_id_fk" FOREIGN KEY ("rig_id") REFERENCES "public"."rig"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_bead_id_uq" ON "issue" USING btree ("bead_id") WHERE "issue"."bead_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_rig_idx" ON "project" USING btree ("rig_id") WHERE "project"."rig_id" IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION rig_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.prefix <> OLD.prefix THEN
    RAISE EXCEPTION 'A rig prefix is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.next_root < OLD.next_root THEN
    RAISE EXCEPTION 'A rig root counter never decreases'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER rig_guard
  BEFORE UPDATE ON rig
  FOR EACH ROW EXECUTE FUNCTION rig_guard();
--> statement-breakpoint
CREATE FUNCTION rig_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A rig is never deleted: its ledger holds the tombstones its ids rely on'
    USING ERRCODE = '23503';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER rig_no_delete
  BEFORE DELETE ON rig
  FOR EACH ROW EXECUTE FUNCTION rig_no_delete();
--> statement-breakpoint
CREATE FUNCTION bead_identity_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.rig_id <> OLD.rig_id
    OR NEW.local_token <> OLD.local_token
    OR NEW.root IS DISTINCT FROM OLD.root
    OR NEW.child IS DISTINCT FROM OLD.child
    OR NEW.origin <> OLD.origin THEN
    RAISE EXCEPTION 'A bead identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.issue_id IS NOT NULL AND NEW.issue_id IS NOT NULL AND NEW.issue_id <> OLD.issue_id THEN
    RAISE EXCEPTION 'A bead identity cannot move to another issue'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.issue_id IS NULL AND NEW.issue_id IS NOT NULL THEN
    RAISE EXCEPTION 'A released bead identity cannot be reclaimed'
      USING ERRCODE = '23514';
  END IF;
  -- A null link is released by deleting the issue, never by detaching it while the issue
  -- still exists. ON DELETE SET NULL runs after the issue row is gone, so the EXISTS check
  -- is false there and the FK action passes.
  IF OLD.issue_id IS NOT NULL AND NEW.issue_id IS NULL
    AND EXISTS (SELECT 1 FROM issue WHERE id = OLD.issue_id) THEN
    RAISE EXCEPTION 'A bead identity is released by deleting its issue, not by detaching it'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER bead_identity_guard
  BEFORE UPDATE ON bead_identity
  FOR EACH ROW EXECUTE FUNCTION bead_identity_guard();
--> statement-breakpoint
CREATE FUNCTION bead_identity_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A bead identity is a tombstone and is never deleted'
    USING ERRCODE = '23503';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER bead_identity_no_delete
  BEFORE DELETE ON bead_identity
  FOR EACH ROW EXECUTE FUNCTION bead_identity_no_delete();
--> statement-breakpoint
CREATE FUNCTION issue_bead_id_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.bead_id IS NOT NULL AND NEW.bead_id IS DISTINCT FROM OLD.bead_id THEN
    RAISE EXCEPTION 'A bead id is set once and never changes or clears'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER issue_bead_id_guard
  BEFORE UPDATE ON issue
  FOR EACH ROW EXECUTE FUNCTION issue_bead_id_guard();
