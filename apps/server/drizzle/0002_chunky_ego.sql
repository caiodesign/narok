ALTER TABLE "stack_items" DROP CONSTRAINT "stack_items_quantity_max";--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "exp_carry" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "two_handed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "bound_to" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_bound_to_characters_id_fk" FOREIGN KEY ("bound_to") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "items_two_handed_offhand_idx" ON "items" USING btree ("equipped_character_id") WHERE "items"."equipped_slot" = 'offhand' or ("items"."equipped_slot" = 'weapon' and "items"."two_handed");--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_exp_carry_range" CHECK ("characters"."exp_carry" >= 0 and "characters"."exp_carry" < 60000);--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_points_nonnegative" CHECK ("characters"."unspent_stat_points" >= 0 and "characters"."unspent_skill_points" >= 0);--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_equipped_slot_known" CHECK ("items"."equipped_slot" is null or "items"."equipped_slot" in ('weapon', 'offhand', 'head', 'body', 'cloak', 'shoes', 'accessory1', 'accessory2'));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_bound_wearer" CHECK ("items"."bound_to" is null or "items"."equipped_character_id" is null or "items"."equipped_character_id" = "items"."bound_to");