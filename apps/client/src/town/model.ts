/**
 * The town view model (milestone B Task 10; part 4 §3.3–§3.5): the adapter
 * between the server's account reads and the Bag, Character and Away screens,
 * the role `hud/model.ts` plays for Hunt. Pure: every function reads its
 * arguments and returns new values; none mutates an input and none reads a
 * clock, so a screen can call any of them on every render.
 *
 * It computes no rule of its own. Disposition is `@narok/loot`'s `evaluate`,
 * the one the server and the simulation run (B-14); attribute costs and the
 * skill-point curve are `@narok/progression`'s and content's (B-16); slot
 * acceptance and bonus stacking are `@narok/data`'s.
 *
 * Ruling R182: a figure the server does not send is left out, never filled in —
 * because every number in the three mockups is a fixture (UI spec §9) and one
 * authoritative account state feeds every screen (part 4 §4).
 */
import {
  EQUIPMENT_SLOTS,
  slotAccepts,
  stackBonuses,
  type Attributes,
  type ClassId,
  type Content,
  type ItemDefinition,
  type ItemInstance,
  type ProgressionTables,
  type Rarity,
  type SkillId,
  type Slot,
} from '@narok/data';
import {
  evaluate,
  LOOT_RARITIES,
  type Disposition,
  type DropDescriptor,
  type LootAction,
  type LootPreset,
} from '@narok/loot';
import { ATTRIBUTE_KEYS, statCost, statStepCost, type AttributeKey } from '@narok/progression';
import type { AwayAction, AwayReportRecord, AwayStatus, CharacterSummary, InventoryResponse } from '../commands';

// -- the bag ------------------------------------------------------------------

/** The bag's tabs. There is no Materials tab: materials do not exist in B (part 4 §4). */
export const BAG_CATEGORIES = ['all', 'equipment', 'consumable'] as const;
export type BagCategory = (typeof BAG_CATEGORIES)[number];

export const BAG_SORTS = ['rarity', 'level', 'name'] as const;
export type BagSort = (typeof BAG_SORTS)[number];

export type BagEntry =
  | { readonly kind: 'item'; readonly key: string; readonly item: ItemInstance }
  | { readonly kind: 'consumable'; readonly key: string; readonly consumableId: string; readonly quantity: number; readonly stacks: number };

/** What occupies the bag's slots, in the server's order: unequipped items, then consumable stacks. */
export function bagEntries(inventory: InventoryResponse | null): BagEntry[] {
  if (inventory === null) return [];
  const items: BagEntry[] = (inventory.items ?? [])
    .filter((entry) => entry.equipped === null)
    .map((entry) => ({ kind: 'item', key: entry.id, item: entry }));
  const consumables: BagEntry[] = (inventory.consumables ?? []).map((stack) => ({
    kind: 'consumable',
    key: `consumable:${stack.consumableId}`,
    consumableId: stack.consumableId,
    quantity: stack.quantity,
    stacks: stack.stacks,
  }));
  return [...items, ...consumables];
}

function inCategory(entry: BagEntry, category: BagCategory): boolean {
  if (category === 'all') return true;
  return category === 'equipment' ? entry.kind === 'item' : entry.kind === 'consumable';
}

export function categoryCounts(entries: readonly BagEntry[]): Record<BagCategory, number> {
  const counts = { all: 0, equipment: 0, consumable: 0 } as Record<BagCategory, number>;
  for (const category of BAG_CATEGORIES) counts[category] = entries.filter((entry) => inCategory(entry, category)).length;
  return counts;
}

export interface BagQuery {
  readonly category: BagCategory;
  readonly search: string;
  readonly sort: BagSort;
}

const rarityRank = (entry: BagEntry): number => (entry.kind === 'item' ? LOOT_RARITIES.indexOf(entry.item.rarity) : -1);
const levelOf = (entry: BagEntry): number => (entry.kind === 'item' ? entry.item.itemLevel : -1);

/** Category, then a case-insensitive name search, then a stable sort (ties keep the server's order). */
export function queryBag(entries: readonly BagEntry[], query: BagQuery, nameOf: (entry: BagEntry) => string): BagEntry[] {
  const needle = query.search.trim().toLocaleLowerCase();
  const kept = entries
    .map((entry, index) => ({ entry, index, name: nameOf(entry) }))
    .filter(({ entry, name }) => inCategory(entry, query.category) && (needle === '' || name.toLocaleLowerCase().includes(needle)));
  kept.sort((a, b) => {
    let order = 0;
    if (query.sort === 'rarity') order = rarityRank(b.entry) - rarityRank(a.entry) || levelOf(b.entry) - levelOf(a.entry);
    else if (query.sort === 'level') order = levelOf(b.entry) - levelOf(a.entry) || rarityRank(b.entry) - rarityRank(a.entry);
    else order = a.name.localeCompare(b.name);
    return order || a.index - b.index;
  });
  return kept.map(({ entry }) => entry);
}

/** Slots used, capacity and free — all from the one returned state, never counted here. */
export function capacityOf(inventory: InventoryResponse | null): { used: number; capacity: number; free: number } | null {
  if (inventory === null) return null;
  return { used: inventory.usedSlots, capacity: inventory.capacity, free: Math.max(0, inventory.capacity - inventory.usedSlots) };
}

export function definitionOf(item: ItemInstance, content: Content): ItemDefinition | undefined {
  return Object.hasOwn(content.items, item.definitionId) ? content.items[item.definitionId] : undefined;
}

// -- equip --------------------------------------------------------------------

/** Why an item cannot go on a character now, in the order the server checks (town first). */
export type EquipBlock =
  | { readonly reason: 'hunting' }
  | { readonly reason: 'unknown' }
  | { readonly reason: 'class'; readonly classes: readonly ClassId[] }
  | { readonly reason: 'level'; readonly required: number; readonly current: number }
  | { readonly reason: 'bound' };

export function equipBlock(item: ItemInstance, character: CharacterSummary, hunting: boolean, content: Content): EquipBlock | null {
  if (hunting) return { reason: 'hunting' };
  const definition = definitionOf(item, content);
  if (definition === undefined) return { reason: 'unknown' };
  if (definition.classes !== null && !definition.classes.includes(character.classId as ClassId)) {
    return { reason: 'class', classes: definition.classes };
  }
  if (character.level < definition.levelRequirement) {
    return { reason: 'level', required: definition.levelRequirement, current: character.level };
  }
  if (item.boundTo !== null && item.boundTo !== character.id) return { reason: 'bound' };
  return null;
}

/** The first character whose class can use `item`, or the first character when none can. */
export function eligibleCharacter(item: ItemInstance, characters: readonly CharacterSummary[], content: Content): CharacterSummary | null {
  const definition = definitionOf(item, content);
  const fits = characters.find(
    (character) =>
      definition !== undefined &&
      (definition.classes === null || definition.classes.includes(character.classId as ClassId)) &&
      (item.boundTo === null || item.boundTo === character.id),
  );
  return fits ?? characters[0] ?? null;
}

export function wornBy(items: readonly ItemInstance[], characterId: string): ItemInstance[] {
  return items.filter((entry) => entry.equipped?.characterId === characterId);
}

/** The slot an item would go into on `characterId`: its own, or for an accessory the free one first. */
export function targetSlot(definition: ItemDefinition, items: readonly ItemInstance[], characterId: string): Slot {
  const accepting = EQUIPMENT_SLOTS.filter((slot) => slotAccepts(definition.slot, slot));
  const worn = wornBy(items, characterId);
  return accepting.find((slot) => !worn.some((entry) => entry.equipped!.slot === slot)) ?? definition.slot;
}

export function equippedIn(items: readonly ItemInstance[], characterId: string, slot: Slot): ItemInstance | null {
  return items.find((entry) => entry.equipped?.characterId === characterId && entry.equipped.slot === slot) ?? null;
}

/** Items in the bag that `character` could put on `slot` now (class, level, binding). */
export function fitsInBag(items: readonly ItemInstance[], character: CharacterSummary, slot: Slot, content: Content): number {
  return items.filter((entry) => {
    if (entry.equipped !== null) return false;
    const definition = definitionOf(entry, content);
    return definition !== undefined && slotAccepts(definition.slot, slot) && equipBlock(entry, character, false, content) === null;
  }).length;
}

/**
 * One compared figure. `unit` says how to print it: `flat` as a number, `bp`
 * in basis points (a percentage-point difference), `ms` as a duration.
 */
export interface StatLine {
  readonly key: string;
  readonly unit: 'flat' | 'bp' | 'ms';
  readonly before: number | null;
  readonly after: number | null;
  readonly delta: number;
}

const BASE_FIGURES = [
  ['weaponAtk', 'flat'],
  ['weaponMatk', 'flat'],
  ['armorDef', 'flat'],
  ['armorMdef', 'flat'],
  ['basicIntervalMs', 'ms'],
] as const;

function figures(item: ItemInstance, content: Content): Map<string, { unit: StatLine['unit']; value: number }> {
  const out = new Map<string, { unit: StatLine['unit']; value: number }>();
  const definition = definitionOf(item, content);
  if (definition !== undefined) {
    for (const [field, unit] of BASE_FIGURES) {
      const value = definition[field];
      if (value !== null && value !== 0) out.set(`base.${field}`, { unit, value });
    }
  }
  const stacked = stackBonuses(item.bonuses, content.bonuses);
  for (const bonusId of Object.keys(stacked)) {
    out.set(`bonus.${bonusId}`, { unit: content.bonuses[bonusId]!.unit, value: stacked[bonusId]! });
  }
  return out;
}

/**
 * The candidate's own figures against what the slot holds: its definition's
 * base values and its rolled bonuses, before and after, with signed deltas.
 * Ruling R187: derived combat stats are not projected here — that formula is
 * the engine's (`@narok/sim`), which the client does not run (B-02).
 */
export function compareItems(candidate: ItemInstance, current: ItemInstance | null, content: Content): StatLine[] {
  const after = figures(candidate, content);
  const before = current === null ? new Map<string, { unit: StatLine['unit']; value: number }>() : figures(current, content);
  const keys = [...after.keys(), ...[...before.keys()].filter((key) => !after.has(key))];
  return keys.map((key) => {
    const was = before.get(key);
    const now = after.get(key);
    return {
      key,
      unit: (now ?? was)!.unit,
      before: was?.value ?? null,
      after: now?.value ?? null,
      delta: (now?.value ?? 0) - (was?.value ?? 0),
    };
  });
}

/** Attribute bonuses a character's worn items add, by their stacking rule. */
export function gearAttributes(worn: readonly ItemInstance[], content: Content): Partial<Record<AttributeKey, number>> {
  const stacked = stackBonuses(worn.flatMap((entry) => entry.bonuses), content.bonuses);
  const out: Partial<Record<AttributeKey, number>> = {};
  for (const bonusId of Object.keys(stacked)) {
    const bonus = content.bonuses[bonusId]!;
    if (bonus.kind === 'attribute' && bonus.attribute !== null) out[bonus.attribute] = (out[bonus.attribute] ?? 0) + stacked[bonusId]!;
  }
  return out;
}

// -- sale (B-15, client half; ruling R185) -------------------------------------

export type SaleRefusal = 'locked' | 'equipped' | 'bound' | 'protected';

/**
 * Why `item` may not be sold now. A locked item is refused until the player
 * unlocks it — the lock command is the explicit unlock; nothing here lifts it.
 */
export function saleRefusal(item: ItemInstance): SaleRefusal | null {
  if (item.locked) return 'locked';
  if (item.equipped !== null) return 'equipped';
  if (item.boundTo !== null) return 'bound';
  if (item.protected) return 'protected';
  return null;
}

export interface SaleSelection {
  readonly itemIds: readonly string[];
  /** Unequipped items of the tier left out, by why. */
  readonly excluded: { readonly locked: number; readonly bound: number; readonly protected: number };
}

/** Every unequipped item of `rarity` that may be sold; locked, bound and protected ones are left out and counted. */
export function bulkSaleSelection(items: readonly ItemInstance[], rarity: Rarity): SaleSelection {
  const excluded = { locked: 0, bound: 0, protected: 0 };
  const itemIds: string[] = [];
  for (const entry of items) {
    if (entry.rarity !== rarity || entry.equipped !== null) continue;
    const refusal = saleRefusal(entry);
    if (refusal === null) itemIds.push(entry.id);
    else if (refusal !== 'equipped') excluded[refusal] += 1;
  }
  return { itemIds, excluded };
}

/** What a sale would do to the bag: items and slots. No gold — prices are deferred (spec §4.0). */
export function salePreview(selection: SaleSelection): { items: number; slotsFreed: number } {
  // Each selected item is unequipped, so each holds exactly one slot.
  return { items: selection.itemIds.length, slotsFreed: selection.itemIds.length };
}

// -- the loot filter (B-14) ----------------------------------------------------

/** What the evaluator sees of a held item: its own rolled record and its definition's slot. */
export function dropOf(item: ItemInstance, content: Content): DropDescriptor {
  return {
    category: 'equipment',
    definitionId: item.definitionId,
    slot: definitionOf(item, content)?.slot ?? null,
    rarity: item.rarity,
    bonusIds: item.bonuses.map((bonus) => bonus.bonusId),
    itemLevel: item.itemLevel,
  };
}

export interface PreviewRecord {
  readonly key: string;
  readonly drop: DropDescriptor;
}

export interface PreviewRow {
  readonly key: string;
  readonly drop: DropDescriptor;
  /** Under the draft. */
  readonly disposition: Disposition;
  /** Under the saved preset, when there is one. */
  readonly saved: Disposition | null;
  /** The draft would act differently from the saved filter. */
  readonly changed: boolean;
}

/** Runs the shared evaluator over each record under the draft and the saved preset. Writes nothing. */
export function previewFilter(records: readonly PreviewRecord[], draft: LootPreset, saved: LootPreset | null): PreviewRow[] {
  return records.map(({ key, drop }) => {
    const disposition = evaluate(drop, draft);
    const was = saved === null ? null : evaluate(drop, saved);
    return { key, drop, disposition, saved: was, changed: was !== null && was.action !== disposition.action };
  });
}

export function tally(rows: readonly PreviewRow[]): Record<LootAction, number> {
  const out: Record<LootAction, number> = { keep: 0, 'auto-sell': 0, ignore: 0 };
  for (const row of rows) out[row.disposition.action] += 1;
  return out;
}

// -- character (B-16) ------------------------------------------------------------

export type AttributeSpend = Partial<Record<AttributeKey, number>>;

/** The cost of a staged spend, replayed per attribute by `@narok/progression`'s own `statCost`. */
export function draftCost(attributes: Attributes, spend: AttributeSpend): number {
  let cost = 0;
  for (const key of ATTRIBUTE_KEYS) {
    const amount = spend[key] ?? 0;
    if (amount > 0) cost += statCost(attributes[key], attributes[key] + amount);
  }
  return cost;
}

export type StageRefusal = 'points' | 'cap';

/** The cost of the next point of `key` given what is already staged, and whether it can be afforded. */
export function nextStep(attributes: Attributes, statPoints: number, spend: AttributeSpend, key: AttributeKey, cap: number) {
  const staged = attributes[key] + (spend[key] ?? 0);
  const cost = statStepCost(staged);
  const remaining = statPoints - draftCost(attributes, spend);
  const refused: StageRefusal | null = staged >= cap ? 'cap' : cost > remaining ? 'points' : null;
  return { staged, cost, refused };
}

/** Stages one more point of `key`, or refuses it; never stages what the character cannot afford. */
export function stageAttribute(
  attributes: Attributes,
  statPoints: number,
  spend: AttributeSpend,
  key: AttributeKey,
  cap: number,
): { spend: AttributeSpend; refused: StageRefusal | null } {
  const step = nextStep(attributes, statPoints, spend, key, cap);
  if (step.refused !== null) return { spend, refused: step.refused };
  return { spend: { ...spend, [key]: (spend[key] ?? 0) + 1 }, refused: null };
}

/** Unspent (the server's figure), pending (the staged cost) and what would remain. */
export function allocationSummary(attributes: Attributes, statPoints: number, spend: AttributeSpend) {
  const pending = draftCost(attributes, spend);
  return { unspent: statPoints, pending, remaining: statPoints - pending, affordable: pending <= statPoints, staged: pending > 0 };
}

/** The first level above `level` that grants a skill point, read from content's table; `null` past the last. */
export function nextSkillPointLevel(level: number, tables: ProgressionTables): number | null {
  for (let next = level + 1; next <= tables.levelCap; next++) {
    if ((tables.skillPoints[next - 1] ?? 0) > 0) return next;
  }
  return null;
}

/** What raising a skill still needs: town, a point, or room under the rank cap. */
export type SkillRequirement = 'town' | 'points' | 'max-rank';

export interface SkillRow {
  readonly skillId: SkillId;
  readonly rank: number;
  readonly maxRank: number;
  readonly missing: readonly SkillRequirement[];
}

/**
 * The character's class skills with their ranks and what raising each still
 * needs. Ruling R186: a skill's lock names the rule's own requirements —
 * town, an unspent skill point, room under the rank cap — and nothing else,
 * because content defines no skill-to-skill or level prerequisite.
 */
export function skillRows(character: CharacterSummary, content: Content, hunting: boolean): SkillRow[] {
  const definition = Object.hasOwn(content.classes, character.classId) ? content.classes[character.classId as ClassId] : undefined;
  if (definition === undefined) return [];
  const maxRank = content.progression.maxSkillRank;
  return definition.skills.map((skillId) => {
    const rank = character.skillRanks?.[skillId] ?? 0;
    const missing: SkillRequirement[] = [];
    if (rank >= maxRank) missing.push('max-rank');
    else {
      if (hunting) missing.push('town');
      if ((character.skillPoints ?? 0) < 1) missing.push('points');
    }
    return { skillId, rank, maxRank, missing };
  });
}

// -- away (B-17) ---------------------------------------------------------------

export interface AwayView {
  readonly status: AwayStatus;
  readonly copyKey: string;
  /** A stop for a combat reason; a cap, a full bag or a player's stop is not a failure. */
  readonly isFailure: boolean;
  readonly timeAwayMs: number;
  readonly simulatedMs: number;
  /** The offline cap this absence was measured against: the server's window, not a constant. */
  readonly capMs: number;
  readonly wipes: { readonly thisHunt: number; readonly thisAbsence: number };
  readonly primary: AwayAction | null;
  readonly secondary: readonly AwayAction[];
  /** Recomputed from the current inventory, not from the report. */
  readonly bagFullNow: boolean;
}

const COMBAT_STOPS = new Set(['wipe', 'stalemate', 'potion-floor']);

/**
 * The report's actions, ordered against the current inventory: Manage bag
 * leads only while the bag is still full, so freeing space changes the
 * primary action without rereading the report.
 */
export function awayView(report: AwayReportRecord, inventory: InventoryResponse | null): AwayView {
  const bagFullNow = inventory !== null && inventory.usedSlots >= inventory.capacity;
  let ordered = [...report.actions];
  if (!bagFullNow && ordered[0] === 'manage-bag' && ordered.length > 1) ordered = [...ordered.slice(1), 'manage-bag'];
  return {
    status: report.status,
    copyKey: report.copyKey,
    isFailure: report.status === 'stopped' && report.stopReason !== null && COMBAT_STOPS.has(report.stopReason),
    timeAwayMs: report.timeAwayMs,
    simulatedMs: report.simulatedMs,
    capMs: report.capCutoffWall - report.awayFromWall,
    wipes: { thisHunt: report.wipesThisHunt, thisAbsence: report.outcomes.wipes },
    primary: ordered[0] ?? null,
    secondary: ordered.slice(1),
    bagFullNow,
  };
}

// -- presentation helpers the components share (kept out of components so they
// carry no arithmetic literal; see character.test.tsx) ------------------------

/** Timeline labels alternate above and below the track, as the reference draws them. */
export function markSide(index: number): 'up' | 'down' {
  return index % 2 === 0 ? 'up' : 'down';
}

/**
 * Marks closer than this share of the track (percent) share one label. Labels
 * alternate sides, so two on the same side are at least twice this apart:
 * 30% of the 860 px the track keeps at its narrowest is about 258 px, wider
 * than the longest single-line label either locale draws.
 */
export const MARK_CLUSTER_SHARE = 15;

/** Entries a clustered label lists before it counts the rest. */
export const MARK_CLUSTER_LINES = 3;

export interface MarkCluster<T> {
  /** Where the cluster's label hangs: its first entry's share of the track. */
  readonly share: number;
  readonly items: readonly T[];
}

/**
 * Groups timeline marks, in order, so that no two labels on the track hang
 * closer than `gap` percent: a mark within `gap` of its cluster's first mark
 * joins that cluster. An absence whose events crowd one end of a long track
 * then draws one readable label listing them instead of an overprinted pile.
 */
export function clusterMarks<T>(marks: readonly { share: number; item: T }[], gap = MARK_CLUSTER_SHARE): MarkCluster<T>[] {
  const out: { share: number; items: T[] }[] = [];
  for (const mark of marks) {
    const last = out.at(-1);
    if (last !== undefined && mark.share - last.share < gap) last.items.push(mark.item);
    else out.push({ share: mark.share, items: [mark.item] });
  }
  return out;
}

/** A basis-point value as a percentage figure, e.g. 650 → 6.5. */
export function percentOf(bp: number): number {
  return bp / 100;
}

/** Milliseconds as seconds. */
export function secondsOf(ms: number): number {
  return ms / 1000;
}

/** A part of a whole as a CSS percentage, clamped to 0–100. */
export function shareOf(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}
