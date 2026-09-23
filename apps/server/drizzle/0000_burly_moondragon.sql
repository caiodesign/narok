CREATE TABLE "account_drop_protection" (
	"account_id" uuid NOT NULL,
	"reward_tier" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_drop_protection_account_id_reward_tier_pk" PRIMARY KEY("account_id","reward_tier"),
	CONSTRAINT "drop_protection_counter_nonnegative" CHECK ("account_drop_protection"."counter" >= 0)
);
--> statement-breakpoint
CREATE TABLE "account_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"grant_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_algorithm" text NOT NULL,
	"password_changed_at" bigint NOT NULL,
	"gold" integer DEFAULT 0 NOT NULL,
	"bag_capacity" integer NOT NULL,
	"state_version" bigint DEFAULT 0 NOT NULL,
	"premium_granted_at" timestamp with time zone,
	"premium_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_gold_nonnegative" CHECK ("accounts"."gold" >= 0),
	CONSTRAINT "accounts_bag_capacity_nonnegative" CHECK ("accounts"."bag_capacity" >= 0),
	CONSTRAINT "accounts_state_version_nonnegative" CHECK ("accounts"."state_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"slot" smallint NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"class_id" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"exp" bigint DEFAULT 0 NOT NULL,
	"awarded_level" integer DEFAULT 1 NOT NULL,
	"unspent_stat_points" integer DEFAULT 0 NOT NULL,
	"unspent_skill_points" integer DEFAULT 0 NOT NULL,
	"attributes" jsonb NOT NULL,
	"skills" jsonb NOT NULL,
	"build_template" jsonb,
	"auto_spend" jsonb,
	"hp" integer NOT NULL,
	"mp" integer NOT NULL,
	"dead" boolean DEFAULT false NOT NULL,
	CONSTRAINT "characters_slot_range" CHECK ("characters"."slot" >= 0 and "characters"."slot" <= 2),
	CONSTRAINT "characters_level_positive" CHECK ("characters"."level" >= 1),
	CONSTRAINT "characters_awarded_level" CHECK ("characters"."awarded_level" <= "characters"."level"),
	CONSTRAINT "characters_hp_nonnegative" CHECK ("characters"."hp" >= 0),
	CONSTRAINT "characters_mp_nonnegative" CHECK ("characters"."mp" >= 0)
);
--> statement-breakpoint
CREATE TABLE "command_results" (
	"account_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"state_version_after" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "command_results_account_id_idempotency_key_pk" PRIMARY KEY("account_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "hunt_checkpoint_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"captured_for" text NOT NULL,
	"checkpoint" "bytea" NOT NULL,
	"checkpoint_schema_version" integer NOT NULL,
	"simulation_version" text NOT NULL,
	"content_version" text NOT NULL,
	"grid_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hunt_archive_captured_for" CHECK ("hunt_checkpoint_archive"."captured_for" in ('migration', 'fault'))
);
--> statement-breakpoint
CREATE TABLE "hunt_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hunts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"map_id" text NOT NULL,
	"checkpoint" "bytea" NOT NULL,
	"checkpoint_schema_version" integer NOT NULL,
	"simulation_version" text NOT NULL,
	"content_version" text NOT NULL,
	"grid_hash" text NOT NULL,
	"sim_anchor_ms" bigint NOT NULL,
	"wall_anchor_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"faulted_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hunts_generation_nonnegative" CHECK ("hunts"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"base_item_id" text NOT NULL,
	"base_content_version" text NOT NULL,
	"rarity" text NOT NULL,
	"item_level" integer NOT NULL,
	"bonuses" jsonb NOT NULL,
	"tradeable" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"equipped_character_id" uuid,
	"equipped_slot" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_equipped_pairing" CHECK (("items"."equipped_character_id" is null) = ("items"."equipped_slot" is null)),
	CONSTRAINT "items_not_tradeable_in_beta" CHECK ("items"."tradeable" = false)
);
--> statement-breakpoint
CREATE TABLE "loot_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_schema_version" integer NOT NULL,
	"preset_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"cutoff_at" timestamp with time zone,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL,
	CONSTRAINT "maintenance_single_row" CHECK ("maintenance"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "periodic_jobs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_completed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "resource_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "resource_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"source_ref" text NOT NULL,
	"delta" jsonb NOT NULL,
	"state_version_after" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "stack_items" (
	"account_id" uuid NOT NULL,
	"definition_id" text NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "stack_items_account_id_definition_id_pk" PRIMARY KEY("account_id","definition_id"),
	CONSTRAINT "stack_items_quantity_nonnegative" CHECK ("stack_items"."quantity" >= 0),
	CONSTRAINT "stack_items_quantity_max" CHECK ("stack_items"."quantity" <= 999)
);
--> statement-breakpoint
CREATE TABLE "strategy_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_schema_version" integer NOT NULL,
	"grid_hash" text,
	"preset_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_drop_protection" ADD CONSTRAINT "account_drop_protection_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_grants" ADD CONSTRAINT "account_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_results" ADD CONSTRAINT "command_results_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_reports" ADD CONSTRAINT "hunt_reports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunts" ADD CONSTRAINT "hunts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_equipped_character_id_characters_id_fk" FOREIGN KEY ("equipped_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loot_presets" ADD CONSTRAINT "loot_presets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_items" ADD CONSTRAINT "stack_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_presets" ADD CONSTRAINT "strategy_presets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_grants_key_idx" ON "account_grants" USING btree ("account_id","grant_key");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_lower_idx" ON "accounts" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "characters_account_slot_idx" ON "characters" USING btree ("account_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "characters_name_key_idx" ON "characters" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "command_results_expires_idx" ON "command_results" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "hunt_archive_account_idx" ON "hunt_checkpoint_archive" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "hunt_reports_account_idx" ON "hunt_reports" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "hunts_running_idx" ON "hunts" USING btree ("status") WHERE "hunts"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "items_equipped_slot_idx" ON "items" USING btree ("equipped_character_id","equipped_slot") WHERE "items"."equipped_character_id" is not null;--> statement-breakpoint
CREATE INDEX "items_bag_idx" ON "items" USING btree ("account_id") WHERE "items"."equipped_character_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "loot_presets_account_name_idx" ON "loot_presets" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX "loot_presets_account_idx" ON "loot_presets" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "resource_audit_account_idx" ON "resource_audit" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "resource_audit_source_idx" ON "resource_audit" USING btree ("source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_presets_account_name_idx" ON "strategy_presets" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX "strategy_presets_account_idx" ON "strategy_presets" USING btree ("account_id");