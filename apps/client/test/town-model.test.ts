/**
 * The town view model (milestone B Task 10; part 4 §3.3–§3.5): the adapter
 * the Bag, Character and Away screens read, as `hud/model.ts` is Hunt's.
 *
 * B-14: the loot-filter preview runs `@narok/loot`'s own `evaluate` — the one
 * the server and the simulation run — and mutates no drop record. B-15's
 * client half: the sale selection excludes locked items, refuses a locked
 * item's sale without an explicit unlock, and previews counts only — no gold,
 * no price key (prices are deferred; ruling R185). B-16's rules: the staged
 * cost is `@narok/progression`'s, and the skill-point curve is content's.
 */
import { describe, expect, test } from 'vitest';
import { content, type ItemInstance, type ProgressionTables } from '@narok/data';
import { evaluate, type DropDescriptor, type LootPreset } from '@narok/loot';
import { statCost } from '@narok/progression';
import type { AwayReportRecord, CharacterSummary, InventoryResponse } from '../src/commands';
import {
  allocationSummary,
  awayView,
  bagEntries,
  bulkSaleSelection,
  categoryCounts,
  compareItems,
  draftCost,
  dropOf,
  equipBlock,
  nextSkillPointLevel,
  previewFilter,
  queryBag,
  saleRefusal,
  salePreview,
  skillRows,
  stageAttribute,
  tally,
} from '../src/town/model';

const ACCOUNT = 'a0000000-0000-4000-8000-000000000001';
const KAIO = 'c0000000-0000-4000-8000-000000000003';

let serial = 0;
function item(overrides: Partial<ItemInstance> = {}): ItemInstance {
  serial += 1;
  return {
    id: `i0000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
    accountId: ACCOUNT,
    definitionId: 'padded-vest',
    contentVersion: content.version,
    rarity: 'common',
    itemLevel: 3,
    bonuses: [],
    tradeable: false,
    locked: false,
    protected: false,
    equipped: null,
    boundTo: null,
    source: { huntId: 'h', rewardSeq: serial },
    ...overrides,
  };
}

function inventory(items: ItemInstance[], extra: Partial<InventoryResponse> = {}): InventoryResponse {
  return {
    capacity: 10,
    usedSlots: items.filter((entry) => entry.equipped === null).length + 1,
    gold: 120,
    stateVersion: 4,
    items,
    consumables: [{ consumableId: 'small-hp-potion', quantity: 20, stacks: 1 }],
    ...extra,
  };
}

const kaio: CharacterSummary = {
  id: KAIO,
  slot: 2,
  name: 'Kaio',
  classId: 'ranger',
  level: 2,
  exp: 10,
  expToNext: 100,
  attributes: { str: 1, agi: 5, vit: 3, int: 1, dex: 11, luk: 1 },
  statPoints: 7,
  skillPoints: 1,
  skillRanks: { 'double-shot': 1 },
  hp: 50,
  mp: 20,
  maxHp: 60,
  maxMp: 30,
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('B-14: the filter preview is the shared evaluator', () => {
  const preset: LootPreset = {
    exceptions: [
      { when: { category: 'equipment', minItemLevel: 5 }, action: 'keep' },
      { when: { category: 'equipment' }, action: 'auto-sell' },
      { when: { slot: 'body' }, action: 'ignore' },
    ],
    rarity: { common: 'ignore' },
    fallback: { equipment: 'keep', consumable: 'keep' },
  };

  const drop = (overrides: Partial<DropDescriptor>): DropDescriptor => ({
    category: 'equipment',
    definitionId: 'padded-vest',
    slot: 'body',
    rarity: 'common',
    bonusIds: [],
    itemLevel: 1,
    ...overrides,
  });

  test('Legendary is protected and kept before any exception', () => {
    const [row] = previewFilter([{ key: 'l', drop: drop({ rarity: 'legendary' }) }], preset, null);
    expect(row!.disposition).toEqual({ action: 'keep', matched: 'protected' });
  });

  test('ordered exceptions, first match wins', () => {
    const rows = previewFilter(
      [
        { key: 'high', drop: drop({ itemLevel: 9 }) },
        { key: 'low', drop: drop({ itemLevel: 2 }) },
      ],
      preset,
      null,
    );
    expect(rows.map((row) => row.disposition)).toEqual([
      { action: 'keep', matched: { exception: 0 } },
      { action: 'auto-sell', matched: { exception: 1 } },
    ]);
  });

  test('then the rarity rule, then the mandatory per-category fallback', () => {
    const plain: LootPreset = { exceptions: [], rarity: { common: 'ignore' }, fallback: { equipment: 'keep', consumable: 'auto-sell' } };
    const rows = previewFilter(
      [
        { key: 'common', drop: drop({}) },
        { key: 'rare', drop: drop({ rarity: 'rare' }) },
        { key: 'potion', drop: drop({ category: 'consumable', slot: null, rarity: null, definitionId: 'small-hp-potion' }) },
      ],
      plain,
      null,
    );
    expect(rows.map((row) => row.disposition)).toEqual([
      { action: 'ignore', matched: 'default' },
      { action: 'keep', matched: 'default' },
      { action: 'auto-sell', matched: 'default' },
    ]);
  });

  test('every row is exactly what `evaluate` answers, and the difference from the saved filter is marked', () => {
    const saved: LootPreset = { exceptions: [], rarity: {}, fallback: { equipment: 'keep', consumable: 'keep' } };
    const records = [
      { key: 'a', drop: drop({ itemLevel: 9 }) },
      { key: 'b', drop: drop({ rarity: 'epic', itemLevel: 1 }) },
    ];
    const rows = previewFilter(records, preset, saved);
    rows.forEach((row, index) => {
      expect(row.disposition).toEqual(evaluate(records[index]!.drop, preset));
      expect(row.saved).toEqual(evaluate(records[index]!.drop, saved));
    });
    expect(rows.map((row) => row.changed)).toEqual([false, true]);
    expect(tally(rows)).toEqual({ keep: 1, 'auto-sell': 1, ignore: 0 });
  });

  test('the preview mutates no drop record and no preset', () => {
    const records = deepFreeze([{ key: 'a', drop: drop({ bonusIds: ['dex'] }) }]);
    const frozen = deepFreeze(structuredClone(preset));
    const before = structuredClone(records);
    expect(() => previewFilter(records, frozen, frozen)).not.toThrow();
    expect(records).toEqual(before);
  });

  test('a held item is described to the evaluator from its own record and its definition', () => {
    const vest = item({ rarity: 'rare', itemLevel: 7, bonuses: [{ bonusId: 'vit', value: 2 }, { bonusId: 'max-hp', value: 300 }] });
    expect(dropOf(vest, content)).toEqual({
      category: 'equipment',
      definitionId: 'padded-vest',
      slot: content.items['padded-vest']!.slot,
      rarity: 'rare',
      bonusIds: ['vit', 'max-hp'],
      itemLevel: 7,
    });
  });
});

describe('B-15 (client half): the sale selection', () => {
  test('a bulk selection excludes locked, equipped, bound and protected items', () => {
    const plain = item();
    const locked = item({ locked: true });
    const worn = item({ equipped: { characterId: KAIO, slot: 'body' } });
    const bound = item({ boundTo: KAIO });
    const shielded = item({ protected: true });
    const rare = item({ rarity: 'rare' });
    const selection = bulkSaleSelection([plain, locked, worn, bound, shielded, rare], 'common');
    expect(selection.itemIds).toEqual([plain.id]);
    expect(selection.excluded).toEqual({ locked: 1, bound: 1, protected: 1 });
  });

  test('a locked item’s sale is refused until it is explicitly unlocked', () => {
    const locked = item({ locked: true });
    expect(saleRefusal(locked)).toBe('locked');
    expect(saleRefusal({ ...locked, locked: false })).toBeNull();
    expect(saleRefusal(item({ boundTo: KAIO }))).toBe('bound');
    expect(saleRefusal(item({ equipped: { characterId: KAIO, slot: 'body' } }))).toBe('equipped');
  });

  test('the preview counts items and slots freed, and carries no gold and no price', () => {
    const selection = bulkSaleSelection([item(), item(), item({ locked: true })], 'common');
    const preview = salePreview(selection);
    expect(preview).toEqual({ items: 2, slotsFreed: 2 });
    expect(Object.keys(preview).sort()).toEqual(['items', 'slotsFreed']);
  });
});

describe('the bag projection', () => {
  const bow = item({ definitionId: 'ranger-bow', rarity: 'epic', itemLevel: 9 });
  const cap = item({ definitionId: 'leather-cap', rarity: 'uncommon', itemLevel: 4 });
  const worn = item({ definitionId: 'wool-cloak', equipped: { characterId: KAIO, slot: 'cloak' } });
  const bag = inventory([bow, cap, worn]);
  const names: Record<string, string> = { [bow.id]: 'Bow', [cap.id]: 'Cap', 'consumable:small-hp-potion': 'Potion' };
  const nameOf = (entry: { key: string }) => names[entry.key] ?? entry.key;

  test('only what takes a slot is in the grid: unequipped items and consumable stacks', () => {
    const entries = bagEntries(bag);
    expect(entries.map((entry) => entry.key)).toEqual([bow.id, cap.id, 'consumable:small-hp-potion']);
    expect(categoryCounts(entries)).toEqual({ all: 3, equipment: 2, consumable: 1 });
  });

  test('search, category and sort compose', () => {
    const entries = bagEntries(bag);
    expect(queryBag(entries, { category: 'equipment', search: '', sort: 'rarity' }, nameOf).map((entry) => entry.key)).toEqual([bow.id, cap.id]);
    expect(queryBag(entries, { category: 'all', search: '', sort: 'name' }, nameOf).map((entry) => entry.key)).toEqual([bow.id, cap.id, 'consumable:small-hp-potion']);
    expect(queryBag(entries, { category: 'all', search: 'pot', sort: 'name' }, nameOf).map((entry) => entry.key)).toEqual(['consumable:small-hp-potion']);
    expect(queryBag(entries, { category: 'consumable', search: 'bow', sort: 'level' }, nameOf)).toEqual([]);
  });
});

describe('equip eligibility and comparison', () => {
  test('hunting is named first, then class, then level with both levels', () => {
    const bow = item({ definitionId: 'ranger-bow' });
    expect(equipBlock(bow, kaio, true, content)).toEqual({ reason: 'hunting' });
    expect(equipBlock(bow, { ...kaio, classId: 'cleric' }, false, content)).toEqual({ reason: 'class', classes: ['ranger'] });
    const required = content.items['ranger-bow']!.levelRequirement;
    const low = { ...kaio, level: required - 1 };
    if (required > 1) expect(equipBlock(bow, low, false, content)).toEqual({ reason: 'level', required, current: required - 1 });
    expect(equipBlock(bow, kaio, false, content)).toBeNull();
    expect(equipBlock(item({ definitionId: 'ranger-bow', boundTo: 'someone-else' }), kaio, false, content)).toEqual({ reason: 'bound' });
  });

  test('a comparison against a worn item gives signed deltas per stat', () => {
    const worn = item({ definitionId: 'leather-cap', bonuses: [{ bonusId: 'dex', value: 3 }] });
    const candidate = item({ definitionId: 'leather-cap', bonuses: [{ bonusId: 'dex', value: 1 }, { bonusId: 'luk', value: 2 }] });
    const lines = compareItems(candidate, worn, content);
    expect(lines.find((line) => line.key === 'bonus.dex')).toEqual({ key: 'bonus.dex', unit: 'flat', before: 3, after: 1, delta: -2 });
    expect(lines.find((line) => line.key === 'bonus.luk')).toEqual({ key: 'bonus.luk', unit: 'flat', before: null, after: 2, delta: 2 });
  });

  test('an empty slot compares against nothing: every line is a gain from null', () => {
    const candidate = item({ definitionId: 'leather-cap', bonuses: [{ bonusId: 'dex', value: 1 }] });
    const lines = compareItems(candidate, null, content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.before === null)).toBe(true);
    expect(lines.find((line) => line.key === 'bonus.dex')).toMatchObject({ after: 1, delta: 1 });
  });
});

describe('B-16 rules read from progression and content', () => {
  test('the staged cost is @narok/progression’s statCost, replayed per attribute', () => {
    const attributes = kaio.attributes!;
    expect(draftCost(attributes, { dex: 2, agi: 1 })).toBe(statCost(11, 13) + statCost(5, 6));
  });

  test('staging refuses a point the character cannot afford, and never overspends', () => {
    const attributes = kaio.attributes!;
    let spend = {};
    let refused: string | null = null;
    for (let index = 0; index < 10; index++) {
      const next = stageAttribute(attributes, 7, spend, 'dex', content.progression.attributeCap);
      spend = next.spend;
      refused = next.refused;
    }
    expect(refused).toBe('points');
    const summary = allocationSummary(attributes, 7, spend);
    expect(summary.pending).toBeLessThanOrEqual(7);
    expect(summary.remaining).toBe(7 - summary.pending);
    expect(summary.unspent).toBe(7);
  });

  test('the next skill point comes from content’s table, not a divisor', () => {
    const tables = content.progression;
    const expected = tables.skillPoints.findIndex((points, index) => index >= 2 && points > 0) + 1;
    expect(nextSkillPointLevel(2, tables)).toBe(expected);
    const every2: ProgressionTables = { ...tables, skillPoints: tables.skillPoints.map((_, index) => (index % 2 === 0 ? 1 : 0)) };
    expect(nextSkillPointLevel(2, every2)).toBe(3);
    expect(nextSkillPointLevel(tables.levelCap, tables)).toBeNull();
  });

  test('a skill that cannot be raised names what it is missing', () => {
    const rows = skillRows({ ...kaio, skillPoints: 0 }, content, true);
    const doubleShot = rows.find((row) => row.skillId === 'double-shot')!;
    expect(doubleShot.rank).toBe(1);
    expect(doubleShot.missing).toEqual(['town', 'points']);
    const capped = skillRows({ ...kaio, skillRanks: { 'double-shot': content.progression.maxSkillRank } }, content, false);
    expect(capped.find((row) => row.skillId === 'double-shot')!.missing).toEqual(['max-rank']);
    expect(rows.map((row) => row.skillId)).toEqual(content.classes.ranger.skills);
  });
});

describe('B-17: the away view', () => {
  const base: AwayReportRecord = {
    reportVersion: 2,
    huntId: 'h',
    generation: 3,
    status: 'running',
    stopReason: null,
    copyKey: 'away.running',
    actions: ['view-hunt'],
    awayFromWall: 1_000,
    returnedAtWall: 1_000 + 3_600_000,
    timeAwayMs: 3_600_000,
    simulatedMs: 3_000_000,
    accrualEndedAtWall: 1_000 + 3_000_000,
    capCutoffWall: 1_000 + 43_200_000,
    uncovered: { afterStopMs: 0, afterCapMs: 0 },
    outcomes: {
      kills: 4,
      wins: 2,
      wipes: 1,
      rawExp: 90,
      rawGold: 40,
      drops: { rolled: 6, kept: 2, autoSold: 1, ignored: 1, lost: 2 },
      consumed: { 'small-hp-potion': 3 },
    },
    wipesThisHunt: 2,
    rewardsCredited: 5,
    mapId: null,
    party: null,
    memberDeaths: null,
    notable: null,
    notableTotal: null,
    timeline: null,
    timelineOmitted: null,
  };

  test('time away and simulated time are separate; the cap is the server’s window', () => {
    const view = awayView(base, inventory([]));
    expect(view.timeAwayMs).toBe(3_600_000);
    expect(view.simulatedMs).toBe(3_000_000);
    expect(view.capMs).toBe(43_200_000);
  });

  test('the wipe counts are the report’s own, and member deaths are not invented', () => {
    const view = awayView(base, inventory([]));
    expect(view.wipes).toEqual({ thisHunt: 2, thisAbsence: 1 });
    expect(Object.keys(view.wipes)).toEqual(['thisHunt', 'thisAbsence']);
  });

  test('the four states carry their copy and actions', () => {
    const room = inventory([]);
    expect(awayView(base, room)).toMatchObject({ status: 'running', primary: 'view-hunt', isFailure: false });
    expect(awayView({ ...base, status: 'capped', copyKey: 'away.capped' }, room)).toMatchObject({ status: 'capped', primary: 'view-hunt', isFailure: false });
    expect(awayView({ ...base, status: 'stopped', stopReason: 'wipe', copyKey: 'away.stopped.wipe', actions: ['start-hunt'] }, room)).toMatchObject({ primary: 'start-hunt', isFailure: true });
    const full = inventory([], { usedSlots: 10, capacity: 10 });
    expect(awayView({ ...base, status: 'bag-full', copyKey: 'away.bagFull', actions: ['manage-bag', 'view-hunt'] }, full)).toMatchObject({
      primary: 'manage-bag',
      secondary: ['view-hunt'],
      bagFullNow: true,
    });
  });

  test('after managing the bag the action state is recomputed from current inventory', () => {
    const report = { ...base, status: 'bag-full' as const, copyKey: 'away.bagFull', actions: ['manage-bag', 'view-hunt'] as const };
    const freed = awayView(report, inventory([], { usedSlots: 6, capacity: 10 }));
    expect(freed.bagFullNow).toBe(false);
    expect(freed.primary).toBe('view-hunt');
    expect(freed.secondary).toEqual(['manage-bag']);
  });
});
