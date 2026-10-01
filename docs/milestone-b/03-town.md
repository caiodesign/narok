# Part 3 — Items, inventory, town and progression

Part of the [milestone B technical specification](../../2026-09-21-milestone-b-spec.md). **Draft, 2026-09-21** —
not accepted; the open decisions at the end of this part are the owner's and nothing here is
implementable until they are recorded. [Layer 1 design](../../layer-1-design.md) and the
[Realm UI specification](../../2026-09-16-realm-ui-spec.md) outrank this document.

Section numbers below are local to this part; cross-part references name the part. This part states rules in prose and tables rather than numbered ids; its acceptance gates live in Part 4 §6.6.

This section specifies what milestone B adds on top of the milestone A simulation: an equipment content model, a deterministic drop and reward pipeline, the shared bag and loot filter, town as the only place manual setup changes happen, and the progression rules that consume both. It does not restate or modify A's combat contracts. Everything A already implements — the event queue, the damage pipeline, `advance` split invariance, the xorshift32 stream (`2026-09-14-simulation-contracts-spec.md` §3–§5) — stays as written; B extends it additively and bumps the pinned versions (layer-1 §4.7).

Two structural consequences are stated once here and assumed below. First, equipment content joins the existing `Content` object and therefore changes `content.version` and the SHA-256 canonical-JSON digest (contracts §2); the golden one-hour fixture is re-pinned with an explained update (layer-1 §12). Second, drops consume PRNG draws inside the kill handler, so the simulation version moves from `'a1'` to `'b1'` and A snapshots are not replayable under B — which is the intended behaviour, not a regression (layer-1 §4.7: never replay an old checkpoint with whichever balance data happens to be deployed now).

### 1. The item model

#### 1.1 Slots, tiers, rarities

Eight equipment slots, fixed (layer-1 §7.1). Slot IDs are ASCII stable identifiers, like every other content ID (contracts §2).

| Slot id | Supplies | Notes |
|---|---|---|
| `weapon` | `weaponAtk`, `weaponMatk`, `basicIntervalMs`, `basicRange`, `basicKind` | Replaces the class-baked weapon fields A hardcodes in `ClassDefinition` |
| `offhand` | `armorDef`, `armorMdef`, bonuses | Blocked by a two-handed weapon (see OPEN DECISION — two-handed compatibility) |
| `head`, `body`, `cloak`, `shoes` | `armorDef`, `armorMdef`, bonuses | Body is the primary armour contributor |
| `accessory1`, `accessory2` | bonuses only | Two distinct slots, not a stack of two; the same definition may occupy both |

Five base tiers with level requirements 1/10/20/30/40 (layer-1 §7.1, proposed default). Five rarities determine rolled bonus count and nothing else:

| Rarity | Rolled bonuses | Protected on drop |
|---|---:|---|
| Common | 0 | no |
| Uncommon | 1 | no |
| Rare | 2 | no |
| Epic | 3 | no |
| Legendary | 4 | yes (layer-1 §7.5, UI §6) |

Rarity is orthogonal to base tier: a Legendary tier-1 item exists and is weaker in base stats than a Common tier-5 item. Base-tier and reward-tier mapping is explicit content, never inferred from rarity (layer-1 §7.2).

#### 1.2 Definition versus instance

A **definition** is immutable versioned content in `packages/data`, hashed with the rest of `Content`, identical for every account. An **instance** is an account-owned row created only by a committed reward or an idempotent grant, carrying the roll outcome. A definition has no owner, no rarity and no bonuses; an instance has no base stats of its own and resolves them through `definitionId` under its pinned `contentVersion`.

```ts
export type Slot = 'weapon' | 'offhand' | 'head' | 'body' | 'cloak' | 'shoes'
  | 'accessory1' | 'accessory2';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export type Handedness = 'one-handed' | 'two-handed' | 'offhand' | 'none';

export interface ItemDefinition {
  id: string; slot: Slot; tier: 1 | 2 | 3 | 4 | 5; levelRequirement: number;
  classes: ClassId[] | null;              // null = any class
  handedness: Handedness;
  weaponAtk: number; weaponMatk: number; armorDef: number; armorMdef: number;
  basicIntervalMs: number | null; basicRange: number | null; basicKind: DamageKind | null;
  basePrice: number;                       // gold, before the rarity multiplier
  fittingBonuses: string[];                // BonusDefinition ids rolled at weight x2
}

export type BonusKind = 'attribute' | 'atk-pct' | 'matk-pct' | 'family-damage'
  | 'element-damage' | 'element-resist' | 'crit' | 'attack-speed' | 'max-hp'
  | 'hp-regen' | 'mp-regen' | 'heal-power';

export interface BonusDefinition {
  id: string; kind: BonusKind; unit: 'flat' | 'bp';
  attribute: keyof Attributes | null; family: Family | null; element: Element | null;
  slots: Slot[];                           // pool membership, slot-specific (layer-1 §7.1)
  spans: { min: number; max: number }[];   // index = valueTier - 1
  stacking: 'sum' | 'max';                 // mandatory per bonus (layer-1 §7.1)
}

export interface RolledBonus { bonusId: string; value: number }

export interface ItemInstance {
  id: string; accountId: string; definitionId: string; contentVersion: string;
  rarity: Rarity; itemLevel: number;       // = dropping monster level (layer-1 §7.2)
  bonuses: RolledBonus[];                  // length === bonusCount(rarity), identities distinct
  tradeable: false;                        // all beta equipment (layer-1 §7.1)
  locked: boolean;                         // user flag; excluded from bulk sale (UI §6)
  protected: boolean;                      // assigned at acquisition; Legendary => true
  equipped: { characterId: string; slot: Slot } | null;
  source: { huntId: string; rewardSeq: number } | { grantId: string };
}
```

`refine`, `cardSlots` and `grade` are deliberately absent; Layer 2 adds them through explicit migrations (layer-1 §7.1, §14). `tradeable` is a literal `false` type rather than a boolean column with no writer, because trade eligibility is a named future-layer boundary (layer-1 §14) and a typed constant documents the intent without creating an unused field.

#### 1.3 Bonus pools and roll constraints

Pools are slot-specific: a bonus is eligible for an item when `bonus.slots.includes(definition.slot)`. No duplicate bonus identity may appear twice on one item (layer-1 §7.1), which imposes a validation rule: every slot's eligible pool must contain at least four distinct identities, otherwise a Legendary of that slot cannot be rolled. Fitting bonuses (listed on the definition) are drawn at weight 2, other eligible bonuses at weight 1 (layer-1 §7.1). Value scales with item level through a value tier; the proposed default is `valueTier = ceil(itemLevel / 10)` (layer-1 §7.1), indexing `spans`.

#### 1.4 Composition with the existing `packages/sim` math

Equipment must feed the formulas A already implements in `packages/sim/src/math.ts`, not a second copy of them. A's `derive(definition: ClassDefinition)` computes, verbatim, `maxHp = floor(((baseHp + hpPerLevel * level) * (100 + vit)) / 100)`, the ranged/melee ATK split keyed on `basicKind === 'physical' && basicRange > 1`, `matk = weaponMatk + int + floor(int / 2)`, `def = armorDef + floor(vit / 2)`, `mdef = armorMdef + floor(int / 2)`, `hit = level + dex`, `flee = level + agi`, `critBp = min(10000, floor(luk / 3) * 100)` and `intervalMs = max(300, ceil((basicIntervalMs * 100) / (100 + agi + floor(dex / 4))))`.

B adds a resolution step in front of it and changes no arithmetic:

```ts
export interface ResolvedLoadout {
  weaponAtk: number; weaponMatk: number; armorDef: number; armorMdef: number;
  basicIntervalMs: number; basicRange: number; basicKind: DamageKind;
  attributeBonus: Attributes;                       // flat, added to allocated attributes
  atkBp: number; matkBp: number; critBpBonus: number; attackSpeedBp: number;
  maxHpBp: number; healPowerBp: number;
  familyBp: Partial<Record<Family, number>>;
  elementBp: Partial<Record<Element, number>>;      // offensive, by attack element
  resistBp: Partial<Record<Element, number>>;       // defensive, by incoming element
  hpRegenFlat: number; mpRegenFlat: number;
}
export function resolveLoadout(items: ItemInstance[], content: Content): ResolvedLoadout;
export function deriveCharacter(input: {
  classId: ClassId; level: number; allocated: Attributes; loadout: ResolvedLoadout;
}): DerivedStats;
```

`resolveLoadout` sums or maxes each bonus by its declared `stacking` rule, applies the empty-slot defaults from the class definition when no weapon is equipped, and validates that slot occupancy is legal. `deriveCharacter` composes a synthetic `ClassDefinition` (class bases plus loadout bases, allocated plus bonus attributes) and **delegates to the existing `derive`**, so there is exactly one implementation of every stat formula. Percentage loadout factors that `derive` has no input for (`atkBp`, `matkBp`, `maxHpBp`, `attackSpeedBp`) are applied by `deriveCharacter` after `derive` returns, each as one floored basis-point step using the same `floor(value * bp / 10000)` convention `math.ts` already uses for damage.

Combat-time bonuses reach `damage()` through two new optional fields, defaulted to 10,000 basis points:

| Field | Inserted at | Source |
|---|---|---|
| `offenseBonusBp` | between step 1 (skill power) and step 2 (element chart) of the milestone A spec §4 ladder | attacker's family-damage and element-damage bonuses for this hit |
| `resistBp` | after step 3 (family), before step 4 (variance) | defender's elemental resistance for the incoming element |

Because `scale(x, 10000) === x` exactly for integer `x` (`math.ts`), an unequipped A-era call is bit-identical with both fields defaulted; the extension cannot move A's golden fixture on its own. `atk`/`matk` percentage bonuses are already folded into `offense` by `deriveCharacter` and are not re-applied here. Flat DEF/MDEF from armour arrive through `defense` unchanged.

#### 1.5 Versioning and validation

Item and bonus content is validated exactly like existing content: a `validateItemContent` written in the style of `packages/data/src/validate.ts`, throwing `ContentError` with `code: 'INVALID_CONTENT'` and a bounded field path, called from the extended `validateContent`. Required checks beyond structural typing: every `fittingBonuses` entry exists and lists the definition's slot; every slot's eligible pool has at least four identities; `levelRequirement` matches the tier ladder; `spans` covers `ceil(maxMonsterLevel / 10)` entries with `min <= max`; `basicIntervalMs`/`basicRange`/`basicKind` are non-null exactly for `slot === 'weapon'`; `basePrice >= 1`; every `BonusKind` in use has a defined `stacking` rule and a defined combat composition path in §1.4 (layer-1 §7.1: "Every implemented bonus requires a defined stacking rule and combat formula").

Instances are not content and are validated at the protocol and database boundaries instead: zod schemas in the `packages/protocol` package B introduces (contracts §1), plus the database constraints layer-1 §8.2 requires — ownership, one item per equipped character/slot, non-negative stack quantities. `bonuses.length === bonusCount(rarity)` and distinct identities are checked on every write path, not only at roll time, so a migration or admin action cannot produce an illegal instance.

### 2. Drops and rewards

#### 2.1 Where the roll happens

Every equipment roll happens in the enemy-death handler, `processDeath` in `packages/sim/src/actions.ts`, at the exact point it already banks `kills`, `rawExp` and `rawGold`. That handler currently consumes no PRNG; B gives it a fixed draw sequence. Rewards are **rolled at death** but **dispositioned at encounter end**: `finishEncounter` (contracts §5) evaluates the loot filter over the encounter's pending reward ledger in ascending `rewardSeq` order, which is kill order, giving the deterministic multi-monster processing layer-1 §7.5 requires. This matches the stated loop walk → fight → loot filter → rest (layer-1 §6.1) while keeping "one equipment roll per kill" (layer-1 §7.2) literally true.

Reward identity is `${huntNamespace}:${rewardSeq}` from a persisted hunt namespace plus a monotonic counter in `SimState`; the simulation never calls an external UUID generator (layer-1 §4.3).

#### 2.2 The per-kill draw sequence

All draws use the existing `drawBelow(state, max)` with `1 <= max <= 1,000,000` (`packages/sim/src/rng.ts`), so a parts-per-million band draw sits exactly at the supported maximum. Order is fixed and consumed in full:

1. **Band draw** — `drawBelow(rng, 1_000_000)`. Always consumed, even when a pity guarantee is pending, so the draw count per kill does not depend on protection state.
2. **Definition draw** — only if a band was hit: `drawBelow(rng, monster.equipment.length)` over the monster's equipment list sorted by definition id.
3. **Bonus draws** — `bonusCount(rarity)` iterations, each consuming one weighted identity draw over the remaining eligible pool and one value draw `spans[valueTier-1].min + drawBelow(rng, span + 1)`. The chosen identity is removed from the pool and the total weight recomputed before the next iteration.
4. **Consumable draw** — `drawBelow(rng, 1_000_000)` against the monster's separate consumable table (layer-1 §7.2: equipment and consumables are separate rolls).
5. **Gold draw** — `drawBelow(rng, goldMax - goldMin + 1)` over the monster's gold range.

Pools and lists are iterated in canonical sorted order, never in object key order (milestone A spec §4: never use iteration order from an unordered external source).

#### 2.3 Band thresholds

Base rates are layer-1 §7.2's table, equal for every account, with one mutually exclusive rarity outcome per kill and the remaining probability meaning no equipment:

| Rarity | Base ppm | Cumulative band (multiplier 1) |
|---|---:|---|
| Common | 5,000 | `[0, 5000)` |
| Uncommon | 2,000 | `[5000, 7000)` |
| Rare | 500 | `[7000, 7500)` |
| Epic | 100 | `[7500, 7600)` |
| Legendary | 10 | `[7600, 7610)` |
| nothing | 992,390 | `[7610, 1000000)` |

The ladder is always built in that ascending-rarity order so the mapping from a draw value to a rarity is a total, versioned function. A monster's drop multiplier scales every band width (`ppm_r * multiplier`, normal 1, tougher roughly 2–3, layer-1 §7.2 proposed defaults); content validation rejects a multiplier whose scaled sum exceeds 1,000,000. Multipliers are tuning inputs chosen from measured encounter economics (layer-1 §7.2), not a design decision this section fixes. Item level equals the dropping monster's level.

The drop roll must not read the loot filter, the bag, or any account setting: two accounts killing the same monster at the same PRNG state must roll the same item. Only the *disposition* of that item varies. Auto-sell consumes no bag slot and no extra draws, so it cannot perturb the stream either. The one exception is the bag-full branch (§3.4), which is a simulation input and is therefore checkpointed.

#### 2.4 Bad-luck protection

Layer-1 §7.3 replaces the old ramp with a hard guarantee after a defined number of eligible opportunities, and layer-1 §7.3 and `docs/phases.md` both schedule the live guarantee for expanded beta, permitting B's baseline experiments to run without it. B therefore ships the **plumbing enabled and the guarantee disabled**: counters accrue, persist and appear in metrics; the override is behind a content flag that stays off until thresholds are selected from simulated wait distributions.

Two counters per account, per reward tier (layer-1 §7.3): `epicPlus` and `legendary`. Specified rules, which are rules and not numbers:

- Counters live in `account_drop_protection` (layer-1 §8.2) and are committed atomically with the checkpoint. Stopping or restarting a hunt never resets them (layer-1 §4.5).
- An award of a tier resets that tier's counter and every lower-tier counter: a Legendary award resets both `legendary` and `epicPlus`; an Epic award resets only `epicPlus`. This is the "how Legendary resets Epic+" rule §7.3 demands.
- When both guarantees are simultaneously due, the higher tier wins and the lower counter is reset by that award. There is never more than one equipment item per kill.
- A guarantee overrides the band **after** the band draw of §2.2 step 1, raising the outcome to the guaranteed tier; it never adds a second item and never lowers a better natural roll.
- Counters increment only on eligible opportunities, defined independently of UI, session length and kill-credit quirks (layer-1 §7.3): an eligible opportunity is one enemy death whose monster has a non-empty equipment list and which produced a band draw. A death at an encounter deadline, a death of a monster with no equipment list, and any admin grant are not opportunities. Low-tier farming cannot prepare a high-tier guarantee because each tier counts its own opportunities under its own weighting.

**OPEN DECISION — pity thresholds, eligibility weighting and disclosure.** Layer-1 §7.3 leaves thresholds, eligibility weighting for monster multipliers, reward-tier boundaries, disclosure and migration open. What must be decided: the `epicPlus` and `legendary` opportunity thresholds; whether an opportunity counts 1 per kill or is weighted by the monster's drop multiplier; whether the counter is disclosed to the player. Options: (a) flat count per kill with a threshold chosen at roughly the 90th percentile of the measured natural wait — simple, but a tougher-monster map reaches the guarantee in fewer kills despite already having better odds; (b) multiplier-weighted opportunities — normalises across maps, harder to explain; (c) expected-value accounting in ppm — most accurate, least legible. Tradeoff is legibility against cross-map fairness. Recommendation: (b) multiplier-weighted opportunities with thresholds selected from `tools/balance` wait-time distributions at the 90th percentile, and no numeric disclosure in beta beyond an away-report line stating that protection exists. Resolve before enabling the guarantee in expanded beta, not before B ships.

#### 2.5 What the checkpoint must retain

For a replay to produce the same drops, the checkpoint (layer-1 §4.3) must carry, in addition to what A already stores:

| Field | Why a replay needs it |
|---|---|
| `rng` | Already in `SimState`; now also advanced by reward draws |
| `nextRewardSeq` | Reproducible, collision-safe reward IDs (layer-1 §4.3) |
| `pendingRewards[]` | Rolled but not yet dispositioned items for the in-progress encounter |
| `dropProtection { epicPlus, legendary }` | Guarantee state; must match `account_drop_protection` at commit |
| `lootPresetSnapshot` + version | The filter that will run at `finishEncounter`, not the preset the player is currently editing |
| `bagState { capacity, usedSlots, stackHeadroom }` | The bag-full branch is a simulation decision |
| `loadoutHash` per character | Derived stats must recompute identically |
| `expCarry`, `awardedLevels`, `autoSpendTemplate` per character | §5 progression determinism |
| `simulationVersion`, `contentVersion`, `gridHash` | Already present; now gate item content too |

Because bag occupancy is a simulation input, a town action that frees slots while a hunt runs must first settle elapsed progress to the server command time and then create a new checkpoint, under the mutation sequence in layer-1 §8.1. A stale worker result computed against the old bag state is rejected, not merged.

### 3. Inventory and the loot filter

#### 3.1 Bag

One shared account bag of 100 slots; consumables stack to 999; equipped items occupy no bag slot (layer-1 §7.5, proposed defaults). Equipment instances never stack and occupy exactly one slot each. Potions are consumed from the shared bag; simultaneous consumers use deterministic ordering — ascending character id, resolved inside the single-threaded simulation — and cannot consume the same unit (layer-1 §7.5).

#### 3.2 Three distinct concepts

The documents use "protected", "locked" and "kept" near each other; B separates them:

| Concept | Where it lives | Meaning |
|---|---|---|
| Disposition | Evaluator output per drop | `Keep`, `Auto-sell` or `Ignore` (layer-1 §7.5) |
| `protected` | Instance field, set at acquisition | The filter may not assign Auto-sell or Ignore; Legendary drops are always protected (layer-1 §7.5, UI §6) |
| `locked` | Instance field, user-toggled any time | Excluded from bulk sale; must be unlocked before individual sale (UI §6) |

"Always kept" means protected disposition, not unlimited capacity: if Keep cannot fit, the configured bag-full policy applies (UI §6). Individual sale of a protected valuable item requires a deliberate confirmation; a locked item must be unlocked first, and that unlock is itself the deliberate step for locked-but-unprotected items.

**OPEN DECISION — protected-item sale confirmation threshold.** UI §6 requires deliberate confirmation for "protected valuable items" but does not say which items qualify. Options: (a) protected only, i.e. Legendary — narrowest, matches §7.5's protection rule exactly; (b) rarity ≥ Epic — catches the items players most regret; (c) any item whose sale price exceeds a configured gold threshold — value-accurate but needs a price the economy has not produced yet. Tradeoff is friction against regret. Recommendation: (b), with the confirmation dialog naming the item, its rarity and its exact gold price, and no "don't ask again" option in beta.

#### 3.3 Filter evaluation

The evaluator is one pure function shared by the server, the simulation and the preview (UI §6: the preview runs the actual evaluator). Precedence, in order (layer-1 §7.5, UI §6):

1. Protection. A Legendary drop receives Keep and is marked protected; no exception or default rule can override it into Auto-sell or Ignore. Existing locked inventory items are outside filter scope entirely and are excluded from bulk sale.
2. Ordered exceptions, evaluated top to bottom, first match wins.
3. The rarity/default rule, with a mandatory fallback covering every supported category so an unmatched drop always has a disposition.

Supported conditions: category, equipment slot, minimum rarity, minimum bonus count, bonus identity, minimum item level (layer-1 §7.5). Material conditions are reserved and their UI stays hidden until materials exist (layer-1 §7.5, UI §6). Actions are Keep, Auto-sell and Ignore; Auto-sell converts directly to gold and consumes no slot. The starter filter auto-sells Common equipment and keeps Uncommon+ and supported consumables, with an explicit fallback for future categories (layer-1 §7.5).

Preview runs the evaluator against recent drop records without altering them, showing proposed disposition, matching rule and the difference from the currently active filter. Apply affects only drops after the acknowledged server cutoff and never retroactively sells existing inventory; the command is validated and versioned with hunt state and rejects stale writes with a recoverable conflict (UI §6). Unsaved edits are labelled and preserved across recoverable failures.

#### 3.4 Bag-full policy and overflow

Party strategy already carries a bag-full behaviour: return to town or stop keeping loot, with auto-sell continuing either way (layer-1 §6.6). Evaluation happens at `finishEncounter` in `rewardSeq` order; the triggering item is the first pending reward whose Keep disposition cannot be placed. Auto-sell and Ignore never trigger it. Missed drops are lost and reopening an away report cannot reclaim them (UI §8), and lost items are never silently added to the bag later (UI §6).

**OPEN DECISION — bag overflow processing.** Layer-1 §7.5 and `docs/phases.md` both leave this open. What must be decided: (i) what happens to a Keep drop that does not fit, (ii) the default party policy value, (iii) whether "return to town" triggers at the offending kill or at encounter end, (iv) stack overflow when a consumable exceeds 999 and no slot is free. Options for (i): **loss** — the item is discarded, recorded in `resource_audit` with an `overflow-lost` reason and surfaced in the away report; **escrow** — a bounded, expiring recovery buffer attached to the report, which contradicts UI §8's "missed drops remain lost" unless that copy is rewritten; **forced sale** — overflow is auto-sold at its filter price, which silently converts a Keep decision (and possibly a protected Legendary) into gold. Tradeoff: loss is honest, auditable and already assumed by the away-report copy, but it can destroy a Legendary; escrow is player-friendly and adds a claim surface, an expiry policy and a second inventory path; forced sale avoids destruction but violates protection semantics. Recommendation: **loss**, with **return to town** as the default policy and the check performed at encounter end so a hunt never aborts mid-fight; stack overflow opens a new stack when a slot is free and otherwise follows the same policy. Revisit only if measured `drops_lost` for a default-configured account is non-trivial.

#### 3.5 Sale and bulk sale

`sellPrice(instance) = max(1, floor(basePrice(definition, itemLevel) * rarityMultiplierBp / 10000))`. Rarity multipliers use layer-1 §7.5's proposed defaults expressed in basis points so the arithmetic stays integer: Common 10,000, Uncommon 15,000, Rare 25,000, Epic 40,000, Legendary 70,000. That single floor with a minimum of one is the integer-price rounding rule §7.5 asks for; no other rounding occurs anywhere in a price.

Bulk sale previews the exact unlocked item count and gold, then reconciles with the server response; duplicate submission is prevented by the account-scoped idempotency key layer-1 §8.1 requires, and all slot, category and wallet counters derive from one returned state (UI §6). Locked items are excluded; protected items are included only when explicitly selected and confirmed per §3.2.

### 4. Town

Town is an account state, not a map: an account is either on its single active hunt (layer-1 §5.1) or in town. Entering town from a running hunt is the explicit retreat transition of layer-1 §4.5, not a silent reset, and it never grants a free heal, seed reset, cooldown reset or encounter reroll.

| Action | Town-only | Rationale |
|---|---|---|
| Equip / unequip / compare | yes | layer-1 §4.5, §7.6; UI §6 "Return to town to equip" |
| Party composition | yes | layer-1 §4.5 |
| Manual stat allocation, skill point spend | yes | layer-1 §4.5, §5.5 |
| Stat / skill respec | yes | layer-1 §5.3 |
| NPC shop (sell items, buy potions) | yes | layer-1 §7.6 |
| Bulk sale, lock/unlock, bag management | no | Reachable from the away report's **Manage bag** while a hunt runs (UI §8) |
| Strategy and loot preset editing / saving | no | Editing is always available; *applying* to a running hunt is a hunt command (UI §5) |
| Auto-spend template editing | yes | It is a manual allocation setting; the hunt uses the checkpointed snapshot |

The NPC buys items and sells potions (layer-1 §7.6). It does **not** sell equipment: equipment enters the economy only through drops and the onboarding grant, which makes potions the only recurring gold sink in Layer 1 and makes "sustainable gold after consumable spending" (layer-1 §7.4) the economy's single tightest metric. Small HP Potion heals 25% of Max HP, Small MP Potion restores 20% of Max MP (layer-1 §7.6, proposed defaults); potion use is instant with a shared 10-second potion cooldown per character (layer-1 §6.6).

**OPEN DECISION — retreat and town-visit cost.** Layer-1 §4.5 and §15 require that returning to town and changing maps consume game time or resources and cannot provide repeated zero-cost encounter sampling or healing, but fix no cost. Options: (a) a simulated return-travel segment of fixed duration during which no encounters spawn and normal walking regen applies, cost = time only; (b) a gold toll per visit; (c) a minimum interval between hunt starts; (d) free, relying on the stop/start invariants — HP, MP, cooldowns, PRNG and pity all preserved (layer-1 §4.5) — to remove the incentive to sample. Tradeoff: (b) taxes the exact players who are already gold-poor; (c) is opaque and feels punitive; (d) is clean but leaves a fast reroll of the *next* encounter recipe available at zero cost. Recommendation: (a) plus (d) — a simulated return-travel segment as the only cost, with every stop/start invariant enforced, and the segment duration set to at least the map's walk interval. The duration is the number to resolve.

**OPEN DECISION — prices: potion price and equipment base price.** Layer-1 §7.6 marks NPC prices open and §15 lists "prices" as a milestone B gate. What must be decided: the gold price of each potion, and the `basePrice` function for equipment definitions. Options for `basePrice`: (a) a flat authored number per definition — total control, high content-authoring cost; (b) a formula from tier and item level, e.g. proportional to the definition's total base stat contribution — automatically consistent as content grows; (c) a formula with a per-definition override. Tradeoff is authoring cost against consistency. Recommendation: (c) — a published formula with an optional override field, potion prices authored flat, and both selected so that a reference party's measured `gold_net` after potion spending is positive but not trivially so across the whole of the map's level band. Both are balance outputs of the experiments in §7, not judgements to make up front.

**OPEN DECISION — starter kit grant boundary.** Layer-1 §7.6 proposes 20 Small HP Potions plus a class starter weapon and explicitly requires that character creation not become a gold or potion faucet. What must be decided: whether the kit is per-account or per-character, and what happens on character deletion. Options: (a) per-character, every creation grants a kit — the faucet §7.6 warns about, since the bag is shared and a create/delete loop mints potions; (b) per-account once, first character only — safe, but a second character starts weaponless; (c) per-character-slot, keyed idempotently on `(accountId, 'starter-kit', characterSlot)`, so recreating a slot grants nothing. Tradeoff: (b) is simplest and slightly unfriendly; (c) is friendly and exploit-free at the cost of one extra key column. Recommendation: (c), with the potions granted only on the first slot and the starter weapon granted per slot as a non-sellable, character-bound item, so neither component can be cycled for value. Every grant is recorded idempotently in `account_grants` (layer-1 §8.2).

**OPEN DECISION — beta equipment persistence and reset policy.** Layer-1 §7.1 requires this to be determined before invitations. What must be decided: whether items and progression survive balance revisions and the beta itself. Options: (a) full persistence with migrations for every content change; (b) persistence with announced wipe points at named milestones; (c) a single wipe at the end of beta. Tradeoff: migrations are the expensive path but the only one that tests the migration machinery layer-1 §4.7 requires; wipes are cheap but devalue the measured economy data. Recommendation: (a) for the duration of the closed beta, with (c) as a stated, announced end-of-beta reset, because the migration path is itself a deliverable the layer-1 design insists on exercising.

### 5. Progression

#### 5.1 Levelling and point budgets

Single level, beta cap 50 (proposed); EXP to next level `floor(50 * level^2.2)` compiled into a versioned content table rather than evaluated at runtime (layer-1 §4.2, §5.3). Reaching a level grants its points exactly once and awarded-level tracking is retained so migrations and retries are safe (layer-1 §5.3).

| Budget | Rule | Total at level 50 |
|---|---|---:|
| Skill points | One at creation, one at every fourth level reached (4, 8, …, 48) | 13 against 20 available ranks (layer-1 §5.3, UI correction table) |
| Stat points | 30 at creation, then `3 + floor(L / 5)` on reaching level `L > 1` | 412 (layer-1 §5.4, proposed) |
| Stat cost | Raising a stat from `v` to `v + 1` costs `2 + floor((v - 1) / 10)`, cap 99 | 1 → 99 costs 628, so 99 is unreachable from points alone |

The mockup's "one skill point every 2 levels" is explicitly corrected away (UI §9). Party EXP is `monsterExp * (1 + 0.1 * (members - 1)) / members` (layer-1 §5.3). To keep the split invariant (layer-1 §4.2), per-kill EXP is computed in integer basis points, floored per member, and the remainder is carried in a per-character `expCarry` field in the checkpoint; totals must therefore be identical whether a hunt is advanced in one segment or many.

#### 5.2 Auto-spend during hunts

Stat auto-spend is available to every account regardless of entitlement (layer-1 §5.5, UI §7 removes its premium badge). It uses optional per-character ordered build targets with recommended class templates, validates affordability, caps and ordered-target behaviour, and carries insufficient points forward. Level-ups allocate immediately and then recompute derived stats through `deriveCharacter`. With auto-spend disabled, points accumulate. Skill points are always manual.

Because level-ups occur mid-hunt, auto-spend runs inside the simulation and must be deterministic: the hunt uses the `autoSpendTemplate` snapshotted into the checkpoint, never a live read of the account row. Template editing is a town action (§4), so the snapshot cannot diverge from the player's intent while a hunt is running.

#### 5.3 Manual allocation, staging and validation

Manual allocation is town-only and staged (UI §7): each attribute control shows its cost and previews before/after values, unspent versus pending cost is shown explicitly, Apply validates and commits atomically, Reset restores the starting values. A staged allocation submits as a delta vector plus the account state version it was built against.

Server validation, in order, rejecting the whole submission on the first failure:

1. Account state version matches the current one (layer-1 §8.1); otherwise `STALE_STATE`.
2. The account is in town and the character is not in an active hunt; otherwise `TOWN_ONLY`.
3. Every delta is a non-negative integer — refunds happen only through respec; otherwise `INVALID_INPUT`.
4. Every resulting attribute value is ≤ 99; otherwise `CAP_EXCEEDED`.
5. The server recomputes total cost by replaying `2 + floor((v - 1) / 10)` for each point in ascending order per attribute and requires it to equal the client's quoted cost; otherwise `COST_MISMATCH`.
6. Total cost ≤ unspent points; otherwise `INSUFFICIENT_POINTS`.

An invalid staged allocation applies nothing — no partial spend — and returns a stable error code with the authoritative state attached. The client refreshes and re-stages rather than overspending or silently discarding the draft (UI §7). Codes are stable identifiers, never localised display text (layer-1 §9). Apply, progression rows, derived-stat recomputation and the account version increment commit in one transaction (layer-1 §8.1).

#### 5.4 Respec

Stat and skill respecs are free in town during beta, refund only earned points, and cannot heal or duplicate resources (layer-1 §5.3). Two consequences B must implement: a respec recomputes derived stats immediately under the HP/MP rule below, and it revalidates saved strategy presets — a rule referencing a skill that is now rank 0 is **disabled, not deleted**, and the player is notified, so a respec cannot silently empty a preset. A respec never changes equipment eligibility, which depends on level and class only.

**OPEN DECISION — HP/MP clamping on maximum-value changes.** Layer-1 §5.3 and §15 leave this open, and equipment makes it urgent: every equip, unequip, respec and level-up moves Max HP/MP. What must be decided: the single rule applied to all maximum-value changes. Options: (a) preserve absolute current HP/MP and clamp to the new maximum — an equip that raises Max HP leaves current HP unchanged, so gear can never heal; (b) preserve the ratio — feels natural but converts a Max HP increase into free healing, which contradicts layer-1 §4.5's rule that town actions grant no recovery; (c) preserve absolute on increase and ratio on decrease — two rules, more explaining. Tradeoff: (a) can leave a character at a low HP fraction after a big gear upgrade; (b) is exploitable by equip-cycling. Recommendation: (a), applied identically to level-up, equip, unequip, respec and content migration, with the away report and character screen showing the resulting values so the drop in percentage is never a surprise.

#### 5.5 Death

A wipe means all party members are dead. **No EXP loss and no de-leveling during beta** (layer-1 §5.6, UI §9 correction table); no EXP-loss language appears anywhere in the away report (UI §8). Death's cost is elapsed time and the resources already spent (layer-1 §5.6).

> **Superseded by the owner decision of 2026-09-30 (Task 7c; rulings R151–R156).** The struck text below no longer holds:
>
> ~~Maximum wipe count defaults to one and is configurable 1–5; that is total allowed wipes, not extra retries (layer-1 §5.6). On reaching the limit the party returns to town and the hunt ends with `wipe-limit`. Before the limit, the explicit respawn transition applies: full HP and MP after 30,000 ms, encounter statuses, casts and threat cleared, cooldown timestamps preserved — which is what A already implements (milestone A spec §10) and the only path that grants that recovery. A single dead member after an otherwise won encounter revives at `max(1, floor(maxHp / 10))` with MP preserved (milestone A spec §10).~~
>
> What replaced it:
> - A dead member stays dead for the rest of the hunt (R151), still ineligible for EXP and still in the divisor.
> - **Idun's Apple** (`idun-apple`, 999-stack, shared bag) revives a member at the instant it dies: one apple, `max(1, floor(maxHp × 50 / 100))` HP, MP as at death, simultaneous deaths in ascending character id (R152). The settlement's commit takes eaten apples off `stack_items`, and the away report lists them under `outcomes.consumed`. No monster drops it and it has no price.
> - The Cleric's **Revive**, cast by a living Cleric with Revive rank ≥ 1 on a dead ally through an `ally-dead` rule, restores the same (R153). MP cost, cast time, cooldown and range are owner placeholders in `OPEN_CONTENT_INPUTS.revive`.
> - A full wipe — everyone dead, no apple or Revive able to act — ends the hunt with stop reason `wipe`. There is no wipe limit and no respawn (R154).
> - Every return to town heals the whole party, living or dead, to full HP and MP (R155, amending R149).
> - A revived member rejoins with statuses, casts and threat cleared and cooldowns kept, at its death cell if free, else its input placement, else the first free party cell; reviving draws no RNG (R156).

**OPEN DECISION — dead-member EXP eligibility.** Layer-1 §5.3 and §5.6 leave open whether a member dead at the moment of a kill receives party EXP. What must be decided: eligibility for EXP and for the party-size divisor. Options: (a) dead members are ineligible and excluded from the divisor — survivors get more, which rewards letting a fragile member die; (b) ineligible but still counted in the divisor — the EXP is destroyed, a real penalty with no de-levelling; (c) fully eligible — simplest, but death then costs nothing but time. Tradeoff: (a) creates a perverse incentive, (c) weakens the only death cost the beta has. Recommendation: (b), because layer-1 §5.6 explicitly wants death to cost elapsed time and resources without an EXP penalty, and destroying the dead member's share is a loss of throughput rather than a loss of stored progress. The low-level monster EXP penalty curve (layer-1 §5.3) stays deferred: B ships one map whose level band makes it inert.

### 6. Onboarding

Layer-1 §7.4 requires a predictable early equipment reward as a one-time onboarding grant that does not need a quest system, with an idempotent grant, and leaves the item and trigger open; `docs/phases.md` lists it among Phase B's open decisions. The mechanism is fixed even though its content is not: the grant is written through `account_grants` (layer-1 §8.2) with key `(accountId, 'onboarding:first-equipment:v1')`, committed in the same transaction as the created `ItemInstance` and its `resource_audit` row, and a repeated call returns the existing instance id rather than minting a second item. The instance's `source` is `{ grantId }`, not a hunt reward, so it never advances `rewardSeq` or a pity counter.

**OPEN DECISION — first equipment reward and its trigger.** What must be decided: which item, at what rarity and item level, on what trigger. Trigger options: (a) character creation, alongside the starter kit — earliest possible, but it arrives before the player has any basis for comparison and teaches nothing about drops; (b) the first won encounter — connects the reward to combat, fires within a minute; (c) the first level-up — lands while the player is already reading the character screen; (d) the Nth kill, with N small. Item options: a fixed Uncommon of the character's weapon slot at item level 1 with a single guaranteed fitting bonus; a fixed Common with no bonuses; a choice of three presented in town. Tradeoff: an earlier trigger shortens "time to first equipment drop" but blurs it as a metric; a choice teaches comparison but adds a decision UI and a state machine before the player understands the words. Recommendation: (b) the first won encounter, granting a fixed **Uncommon weapon** for the character's class at item level 1 with one guaranteed fitting bonus — it demonstrates the rarity, bonus and comparison concepts in a single object, is strictly better than the starter weapon so the comparison screen has an unambiguous first lesson, and keeps the measured "time to first *dropped* equipment" clean because the grant is tagged as a grant and excluded from that metric.

### 7. Economy metrics

Layer-1 §7.4 names the priorities: time to first equipment drop and first useful upgrade; upgrade usefulness across compositions and tiers; sustainable gold after consumable spending; time until bag limits or resource exhaustion force intervention; distributions rather than averages for Epic and Legendary waits; and equipment generated, retained, equipped and sold by tier and rarity.

`tools/balance` already produces the run harness and half the inputs. `run` and `matrix` construct explicit inputs and drive the same `Simulation` the client uses (`tools/balance/src/run.ts`), and `writeCsv` emits a fixed column list (`tools/balance/src/csv.ts`) that today carries kills, wins, wipes, the three phase-time totals, `raw_exp`, `raw_gold`, damage, healing and `kills_per_hour`. Milestone A's spec deliberately forbade naming a column "net gold" or "useful upgrades" until a real economy existed; B creates it, so those columns become legitimate.

| Metric (layer-1 §7.4) | Produced by | Change required |
|---|---|---|
| Time to first equipment drop | `run`, per seed | New columns `first_drop_ms`, `first_drop_rarity` |
| Time to first useful upgrade | `run`, per seed | New column `first_upgrade_ms`; needs the upgrade estimator below |
| Upgrade usefulness by composition and tier | `matrix` (34 compositions × 3 recipes × 3 placements) | New columns `upgrades_found`, `upgrades_equipped`, per-composition aggregation |
| Sustainable gold | `run`, `matrix` | `gold_gross`, `gold_from_sales`, `gold_spent_potions`, `gold_net` |
| Time until bag intervention | `run` | `bag_full_at_ms`, `bag_full_ms`, `drops_lost`; requires the explicit starting inventory input below |
| Epic/Legendary wait distributions | `run` over many seeds | `epic_wait_kills`, `legendary_wait_kills` per seed, aggregated as distributions, never as a mean (layer-1 §12) |
| Equipment generated / retained / equipped / sold by rarity | `run`, `matrix` | `items_rolled_<rarity>`, `items_kept`, `items_autosold`, `items_bulksold`, `items_equipped` |
| Potion consumption | `run` | `potions_hp_used`, `potions_mp_used` |

Three harness changes make those possible. First, `LabInput` grows into a B-era hunt input carrying a starting bag state, a loadout per character and a loot preset, constructed explicitly by the CLI rather than read from a database — the CLI owns files and clocks and the simulation owns no I/O (contracts §1). Second, an `economy` subcommand emits the loot CSV plus a companion distribution report, following the existing pattern where per-run detail goes to a companion JSON beside the CSV. Third, a post-processing aggregator turns many seeds into wait-time distributions, in the same style as the existing matrix analysis script under `artifacts/`. `benchmark` is untouched: drops add a bounded number of integer draws per kill and do not change the performance question.

**OPEN DECISION — the useful-upgrade threshold.** "Useful upgrade" is the central economy metric and the documents define no threshold. The estimator itself is specifiable: for each dropped item, resolve the owning-class candidate's loadout with and without it through `deriveCharacter`, and score the difference with a deterministic proxy — sustained damage per second computed from `atk`/`matk`, `intervalMs`, `critBp` and hit chance against a reference monster, plus effective HP from `maxHp` and `def`/`mdef`. What must be decided is the threshold that makes a score change count. Options: (a) any strictly positive change — noisy, counts a one-point DEX swap as an upgrade; (b) a fixed percentage, e.g. a whole-number percentage gain in either proxy; (c) a percentile of the measured per-drop score distribution. Tradeoff: a fixed percentage is legible and comparable across content revisions; a percentile self-calibrates but makes two builds' numbers incomparable. Recommendation: (b), a single published percentage applied to both proxies, with the raw score change also written to the CSV so the threshold can be re-cut after the fact without re-running the simulations.

### 8. Open decisions

| # | Decision | Gate | Recommendation |
|---|---|---|---|
| 1 | ~~Two-handed and off-hand compatibility~~ — **decided 2026-09-21 (owner)** | Settled | A two-handed weapon occupies `weapon` and locks `offhand` to empty. Equipping one auto-unequips the off-hand in town, and the transaction fails if the bag cannot hold what comes off |
| 2 | Bonus identity scope for family and element variants (layer-1 §7.1) | Before the bonus pools are authored | Treat each family/element variant as its own identity, so "+Fire damage" and "+Water damage" can coexist on one item; document it, because the alternative silently reduces Legendary variety |
| 3 | Bonus value tier and value spans (layer-1 §7.1) | Before drop balancing | Keep `valueTier = ceil(itemLevel / 10)` as proposed and author explicit per-tier `spans`, so every bonus consumes exactly one value draw |
| 4 | Beta equipment persistence and reset policy (layer-1 §7.1, §15) | Before beta invitations | Full persistence with migrations through the closed beta; one announced end-of-beta reset |
| 5 | Pity thresholds, eligibility weighting and disclosure (layer-1 §7.3, §15) | Before enabling the guarantee in expanded beta | Multiplier-weighted opportunities; thresholds at the 90th percentile of measured natural waits; no numeric disclosure in beta |
| 6 | ~~Bag overflow processing~~ — **decided 2026-09-21 (owner)** | Settled | The drop is **lost**, audited as `overflow-lost`, evaluated at encounter end. The hunt continues: a full bag does not return the party to town. Consumable overflow still starts a new stack when a slot is free |
| 7 | Protected-item sale confirmation threshold (UI §6) | Before the bag screen ships | Rarity ≥ Epic, with the dialog naming item, rarity and exact price; no "don't ask again" |
| 8 | Prices: potion price and equipment base price (layer-1 §7.6, §15) — **deferred by the owner 2026-09-21** | Still open. The NPC shop and potion purchase cannot ship until it is set, so the plan sequences them last | A published `basePrice` formula with a per-definition override; flat potion prices; both selected from measured `gold_net` |
| 9 | Retreat and town-visit cost (layer-1 §4.5, §15) | Milestone B hunt lifecycle | A simulated return-travel segment as the only cost, with every stop/start invariant enforced; duration ≥ the map's walk interval |
| 10 | Starter kit grant boundary (layer-1 §7.6, §15) | Before character creation ships | Idempotent per `(account, 'starter-kit', slot)`; potions on the first slot only; a character-bound, non-sellable starter weapon per slot |
| 11 | ~~First equipment reward and trigger~~ — **decided 2026-09-21 (owner)** | Settled | The **first won encounter** grants a fixed Uncommon item: one fixed definition per class at item level 1 with one fixed bonus at a fixed value, **rolled by nothing** and identical for every account of that class. It consumes no PRNG draw, is tagged as a grant, and is excluded from drop metrics. The stated reason is that creating an account must never be worth doing for a better roll |
| 12 | HP/MP clamping on maximum-value changes (layer-1 §5.3, §15) | Before equipment and allocation ship | Preserve absolute current HP/MP and clamp; identical rule for level-up, equip, unequip, respec and migration |
| 13 | Dead-member EXP eligibility (layer-1 §5.3, §5.6) | Progression implementation | Ineligible but still counted in the party divisor; the share is destroyed, with no EXP loss or de-levelling |
| 14 | The useful-upgrade threshold (layer-1 §7.4) | Before economy metrics are reported | One published percentage against both the damage and effective-HP proxies, with raw score deltas also written to CSV |
