ALTER TABLE "items" ADD COLUMN "protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "source_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "items_source_idx" ON "items" USING btree ("account_id","source_ref") WHERE "items"."source_ref" is not null;