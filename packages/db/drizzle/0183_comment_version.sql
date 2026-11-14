CREATE TABLE "comment_version" (
	"id" serial PRIMARY KEY NOT NULL,
	"comment_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	"author_user_id" text,
	"superseded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_after" boolean DEFAULT false NOT NULL,
	CONSTRAINT "comment_version_comment_revision_unique" UNIQUE("comment_id","revision"),
	CONSTRAINT "comment_version_revision_check" CHECK ("comment_version"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "comment_version" ADD CONSTRAINT "comment_version_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_version_lookup_idx" ON "comment_version" USING btree ("issue_id","comment_id","revision");
--> statement-breakpoint
CREATE FUNCTION comment_version_immutable() RETURNS trigger AS $$
BEGIN
  -- A stored version is history, so nothing may rewrite it. DELETE is deliberately left allowed:
  -- deleteComment hard-deletes the live comment row, and deleting a card cascades its history, so a
  -- blanket append-only trigger would turn both of those into errors.
  RAISE EXCEPTION 'A comment version is immutable'
    USING ERRCODE = '23514';
END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER comment_version_no_update BEFORE UPDATE ON "comment_version"
  FOR EACH ROW EXECUTE FUNCTION comment_version_immutable();
