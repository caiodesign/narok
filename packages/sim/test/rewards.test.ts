import fc from 'fast-check';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { content, validateContent } from '@narok/data';
import type { Content, Rarity } from '@narok/data';
import { STARTER_LOOT_PRESET, type LootPreset } from '@narok/loot';
import { createGrid } from '../src/battlefield/grid';
import { SimError } from '../src/errors';
import { createSimulation, takeDispositionedRewards } from '../src/index';
import { bandFor, dispositionRewards, rollKill } from '../src/rewards';
import { encodeSnapshot, decodeSnapshot } from '../src/snapshot';
import type { BagState, DomainEvent, DropProtection, SimState, Simulation } from '../src/types';
import { context, fightFixture, labInput, runTo } from './fixtures';

// Every draw goes through `drawBelow`; wrapping it lets a test read the exact
// sequence of bounds one kill consumed without changing a single value.
vi.mock('../src/rng', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rng')>();
  return { ...actual, drawBelow: vi.fn(actual.drawBelow) };
});
const { drawBelow } = await import('../src/rng');
const realRng = await vi.importActual<typeof import('../src/rng')>('../src/rng');

test('the layer-1 ppm ladder is a total function at every boundary', () => {
  expect([0, 4_999].map((v) => bandFor(v, 1))).toEqual(['common', 'common']);
  expect(bandFor(5_000, 1)).toBe('uncommon');
  expect(bandFor(7_000, 1)).toBe('rare');
  expect(bandFor(7_500, 1)).toBe('epic');
  expect([7_600, 7_609].map((v) => bandFor(v, 1))).toEqual(['legendary', 'legendary']);
  expect([7_610, 999_999].map((v) => bandFor(v, 1))).toEqual([null, null]);
});

test('a drop multiplier scales every band width, keeping the ascending ladder', () => {
  expect([0, 9_999, 10_000, 13_999, 14_000, 14_999, 15_000, 15_199, 15_200, 15_219, 15_220].map((v) => bandFor(v, 2)))
    .toEqual(['common', 'common', 'uncommon', 'uncommon', 'rare', 'rare', 'epic', 'epic', 'legendary', 'legendary', null]);
  // The largest multiplier content accepts still leaves the ladder inside the draw space.
  expect(bandFor(996_909, 131)).toBe('legendary');
  expect(bandFor(996_910, 131)).toBeNull();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Validated content with `mutate` applied — the version string is kept, it is never re-derived here. */
function variant(mutate: (draft: Content) => void): Content {
  const draft = structuredClone(content);
  mutate(draft);
  return validateContent(draft);
}

/** Every monster at the largest multiplier content accepts: nearly every kill drops. */
const rich = variant((draft) => {
  for (const monster of Object.values(draft.monsters)) monster.dropMultiplier = 131;
});
const guarded = variant((draft) => {
  draft.pity = { guaranteeEnabled: true, epicPlusThreshold: 4, legendaryThreshold: 6 };
});
const bare = variant((draft) => {
  draft.pity = { guaranteeEnabled: true, epicPlusThreshold: 4, legendaryThreshold: 6 };
  draft.monsters['briar-boar'].equipment = [];
});

function simulation(bound: Content): Simulation {
  return createSimulation(bound, createGrid(bound.grid, bound.shapes));
}

/** A seed whose first band draw lands where `accept` says. Uses the real stream, so nothing is recorded. */
function seedWithBand(accept: (value: number) => boolean): number {
  for (let seed = 1; ; seed++) {
    if (accept(realRng.drawBelow(seed, 1_000_000).value)) return seed;
  }
}

const BANDS: Record<Rarity | 'none', (value: number) => boolean> = {
  common: (v) => v < 5_000,
  uncommon: (v) => v >= 5_000 && v < 7_000,
  rare: (v) => v >= 7_000 && v < 7_500,
  epic: (v) => v >= 7_500 && v < 7_600,
  legendary: (v) => v >= 7_600 && v < 7_610,
  none: (v) => v >= 7_610,
};

interface KillSetup {
  bound?: Content;
  rng?: number;
  protection?: DropProtection;
  bag?: BagState;
  loot?: LootPreset;
}

function killState(setup: KillSetup = {}): SimState {
  const state = fightFixture();
  if (setup.rng !== undefined) state.rng = setup.rng;
  if (setup.protection !== undefined) state.dropProtection = { ...setup.protection };
  if (setup.bag !== undefined) state.bagState = structuredClone(setup.bag);
  if (setup.loot !== undefined) state.lootPresetSnapshot = structuredClone(setup.loot);
  return state;
}

function kill(state: SimState, bound: Content = content, monsterId = 'briar-boar'): DomainEvent[] {
  const events: DomainEvent[] = [];
  rollKill(state, bound.monsters[monsterId], { ...context(state, events), content: bound });
  return events;
}

function settle(state: SimState, bound: Content = content): DomainEvent[] {
  const events: DomainEvent[] = [];
  dispositionRewards(state, { ...context(state, events), content: bound });
  return events;
}

/** The bounds of every `drawBelow` call `run` makes, in order. */
function drawsOf(run: () => void): number[] {
  vi.mocked(drawBelow).mockClear();
  run();
  return vi.mocked(drawBelow).mock.calls.map(([, max]) => max);
}

const IGNORE_ALL: LootPreset = { exceptions: [], rarity: {}, fallback: { equipment: 'ignore', consumable: 'ignore' } };
const KEEP_ALL: LootPreset = { exceptions: [], rarity: {}, fallback: { equipment: 'keep', consumable: 'keep' } };

beforeEach(() => {
  vi.mocked(drawBelow).mockClear();
});

// ---------------------------------------------------------------------------
// The fixed per-kill draw sequence (part 3 §2.2)
// ---------------------------------------------------------------------------

describe('the per-kill draw sequence', () => {
  test('a miss consumes the band, consumable and gold draws, in that order', () => {
    const state = killState({ rng: seedWithBand(BANDS.none) });
    expect(drawsOf(() => kill(state))).toEqual([1_000_000, 1_000_000, 1]);
    expect(state.pendingRewards).toEqual([]);
    expect(state.metrics.rawGold).toBe(content.monsters['briar-boar'].goldMin);
  });

  test('a hit adds the definition draw over the sorted list, then one identity and one value draw per bonus', () => {
    const state = killState({ rng: seedWithBand(BANDS.epic) });
    const bounds = drawsOf(() => kill(state));
    const equipment = content.monsters['briar-boar'].equipment.length;
    expect(bounds.slice(0, 2)).toEqual([1_000_000, equipment]);
    expect(bounds).toHaveLength(2 + 2 * 3 + 2);
    expect(bounds.slice(-2)).toEqual([1_000_000, 1]);

    const [reward] = state.pendingRewards;
    expect(reward.item.kind).toBe('equipment');
    if (reward.item.kind !== 'equipment') return;
    expect(reward.item.rarity).toBe('epic');
    expect(reward.itemLevel).toBe(content.monsters['briar-boar'].level);
    expect(new Set(reward.item.bonuses.map((bonus) => bonus.bonusId)).size).toBe(3);

    // Identity draws are over the remaining weight: fitting x2, others x1, the chosen one removed.
    const definition = content.items[reward.item.definitionId];
    const pool = Object.keys(content.bonuses).filter((id) => content.bonuses[id].slots.includes(definition.slot));
    const weightOf = (ids: string[]) => ids.reduce((sum, id) => sum + (definition.fittingBonuses.includes(id) ? 2 : 1), 0);
    let remaining = [...pool];
    reward.item.bonuses.forEach((bonus, index) => {
      expect(bounds[2 + index * 2]).toBe(weightOf(remaining));
      const span = content.bonuses[bonus.bonusId].spans[0];
      expect(bounds[3 + index * 2]).toBe(span.max - span.min + 1);
      expect(bonus.value).toBeGreaterThanOrEqual(span.min);
      expect(bonus.value).toBeLessThanOrEqual(span.max);
      remaining = remaining.filter((id) => id !== bonus.bonusId);
    });
  });

  test('a kill consumes the same draws whether or not a guarantee is pending', () => {
    for (const band of ['none', 'common', 'rare', 'epic'] as const) {
      const rng = seedWithBand(BANDS[band]);
      const plain = killState({ rng });
      const without = drawsOf(() => kill(plain, content));
      // Accruing toward a guarantee that is not yet due changes nothing.
      const pending = killState({ rng, protection: { epicPlus: 2, legendary: 4 } });
      const accruing = drawsOf(() => kill(pending, guarded));
      expect(accruing).toEqual(without);
    }
    // A due guarantee still spends the band draw first and draws exactly what a
    // natural roll of the guaranteed tier draws: the guarantee changes the
    // outcome, never the band draw count.
    const natural = killState({ rng: seedWithBand(BANDS.epic) });
    const naturalEpic = drawsOf(() => kill(natural));
    const due = killState({ rng: seedWithBand(BANDS.none), protection: { epicPlus: 3, legendary: 0 } });
    const guaranteedEpic = drawsOf(() => kill(due, guarded));
    expect(guaranteedEpic[0]).toBe(1_000_000);
    expect(guaranteedEpic).toHaveLength(naturalEpic.length);
    expect(due.pendingRewards[0].item).toMatchObject({ kind: 'equipment', rarity: 'epic' });
  });

  test('rewards are numbered in kill order and carry no RNG state (B-08)', () => {
    const state = killState({ rng: 7 });
    for (let index = 0; index < 20; index++) kill(state, rich);
    const seqs = state.pendingRewards.map((reward) => reward.rewardSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(state.nextRewardSeq).toBe(seqs.length);
    const text = JSON.stringify(state.pendingRewards);
    expect(text).not.toContain('"rng"');
    expect(text).not.toContain('"seed"');
  });
});

// ---------------------------------------------------------------------------
// Stream independence (part 3 §2.3)
// ---------------------------------------------------------------------------

const bagArb: fc.Arbitrary<BagState> = fc
  .integer({ min: 0, max: 5 })
  .chain((capacity) => fc.record({
    capacity: fc.constant(capacity),
    usedSlots: fc.integer({ min: 0, max: capacity }),
    stackHeadroom: fc.constant({}),
  }));
const actionArb = fc.constantFrom('keep' as const, 'auto-sell' as const, 'ignore' as const);
const presetArb: fc.Arbitrary<LootPreset> = fc.record({
  exceptions: fc.array(fc.record({ when: fc.record({ minRarity: fc.constantFrom('uncommon', 'rare', 'epic') }), action: actionArb }), {
    maxLength: 3,
  }),
  rarity: fc.dictionary(fc.constantFrom('common', 'uncommon', 'rare'), actionArb),
  fallback: fc.record({ equipment: actionArb, consumable: actionArb }),
}) as fc.Arbitrary<LootPreset>;
const protectionArb = fc.record({ epicPlus: fc.nat(10_000), legendary: fc.nat(10_000) });

describe('the roll never reads the account', () => {
  test('states differing only in bag, filter and counters reach the same rng and the same rarity after the same kill', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0xffffffff }),
        fc.tuple(bagArb, presetArb, protectionArb),
        fc.tuple(bagArb, presetArb, protectionArb),
        (rng, [bagA, lootA, protectionA], [bagB, lootB, protectionB]) => {
          const a = killState({ rng, bag: bagA, loot: lootA, protection: protectionA });
          const b = killState({ rng, bag: bagB, loot: lootB, protection: protectionB });
          kill(a, rich);
          kill(b, rich);
          expect(a.rng).toBe(b.rng);
          expect(a.pendingRewards.map((reward) => reward.item)).toEqual(b.pendingRewards.map((reward) => reward.item));
          // Disposition may differ, and draws nothing.
          settle(a, rich);
          settle(b, rich);
          expect(a.rng).toBe(b.rng);
        },
      ),
    );
  });

  test('a whole hunt rolls the same drops under a full bag and an ignore-all filter as under an empty bag and keep-all', () => {
    const sim = simulation(rich);
    const input = labInput({ seed: 99 });
    const open = runTo(sim, sim.start(input, { loot: KEEP_ALL, bag: { capacity: 1_000, usedSlots: 0, stackHeadroom: {} } }), 900_000);
    const shut = runTo(sim, sim.start(input, { loot: IGNORE_ALL, bag: { capacity: 0, usedSlots: 0, stackHeadroom: {} }, dropProtection: { epicPlus: 50, legendary: 900 } }), 900_000);
    expect(open.state.metrics.kills).toBeGreaterThan(20);
    expect(shut.state.rng).toBe(open.state.rng);
    expect(shut.state.metrics.drops.rolled).toEqual(open.state.metrics.drops.rolled);
    expect(shut.state.pendingRewards.map((reward) => reward.item)).toEqual(open.state.pendingRewards.map((reward) => reward.item));
    expect(open.state.metrics.drops.kept).toBeGreaterThan(0);
    expect(shut.state.metrics.drops.ignored).toBe(open.state.metrics.drops.kept);
    // Prices are deferred (spec §4.0): an auto-sold item is counted, never
    // priced, so gold is the per-kill gold draws whatever the filter did.
    const starter = runTo(sim, sim.start(input), 900_000).state;
    expect(starter.metrics.drops.autoSold).toBeGreaterThan(0);
    expect(starter.metrics.rawGold).toBe(open.state.metrics.rawGold);
    expect(shut.state.metrics.rawGold).toBe(open.state.metrics.rawGold);
  });

  test('a grant-shaped change between kills consumes no draw and leaves the stream and the rarities unchanged (task 7 grant)', () => {
    // The fixed first-win Uncommon grant (task 7) places one item in the bag and
    // touches nothing the roll reads. Stand-in: occupy one slot after the first
    // won encounter, on one of two otherwise identical hunts.
    const sim = simulation(rich);
    const input = labInput({ seed: 4_242 });
    let plain = sim.start(input);
    while (plain.metrics.wins === 0) plain = sim.advance(plain, plain.nowMs + 1_000).state;
    const granted = structuredClone(plain);
    granted.bagState.usedSlots += 1;

    const later = plain.nowMs + 1_200_000;
    const a = runTo(sim, plain, later).state;
    const b = runTo(sim, granted, later).state;
    expect(b.rng).toBe(a.rng);
    expect(b.nextRewardSeq).toBe(a.nextRewardSeq);
    expect(b.dropProtection).toEqual(a.dropProtection);
    expect(b.metrics.drops.rolled).toEqual(a.metrics.drops.rolled);
    expect(b.pendingRewards.map((reward) => reward.item)).toEqual(a.pendingRewards.map((reward) => reward.item));
    expect(b.bagState.usedSlots).toBe(a.bagState.usedSlots + 1);
  });
});

// ---------------------------------------------------------------------------
// Bad-luck protection (part 3 §2.4)
// ---------------------------------------------------------------------------

describe('the pity reset matrix', () => {
  const cases: {
    name: string; bound: Content; before: DropProtection; band: keyof typeof BANDS;
    rarity: Rarity | null; after: DropProtection; epicWaits: number[]; legendaryWaits: number[];
  }[] = [
    { name: 'a miss accrues both tiers', bound: content, before: { epicPlus: 0, legendary: 0 }, band: 'none', rarity: null, after: { epicPlus: 1, legendary: 1 }, epicWaits: [], legendaryWaits: [] },
    { name: 'a low award accrues both tiers', bound: content, before: { epicPlus: 7, legendary: 9 }, band: 'rare', rarity: 'rare', after: { epicPlus: 8, legendary: 10 }, epicWaits: [], legendaryWaits: [] },
    { name: 'an Epic resets Epic+ only', bound: content, before: { epicPlus: 7, legendary: 9 }, band: 'epic', rarity: 'epic', after: { epicPlus: 0, legendary: 10 }, epicWaits: [8], legendaryWaits: [] },
    { name: 'a Legendary resets itself and every lower tier', bound: content, before: { epicPlus: 7, legendary: 9 }, band: 'legendary', rarity: 'legendary', after: { epicPlus: 0, legendary: 0 }, epicWaits: [8], legendaryWaits: [10] },
    { name: 'a disabled guarantee never fires, however far past any threshold', bound: content, before: { epicPlus: 999, legendary: 999 }, band: 'none', rarity: null, after: { epicPlus: 1_000, legendary: 1_000 }, epicWaits: [], legendaryWaits: [] },
    { name: 'a due Epic+ guarantee raises a miss to Epic', bound: guarded, before: { epicPlus: 3, legendary: 0 }, band: 'none', rarity: 'epic', after: { epicPlus: 0, legendary: 1 }, epicWaits: [4], legendaryWaits: [] },
    { name: 'a guarantee never lowers a better natural roll', bound: guarded, before: { epicPlus: 3, legendary: 0 }, band: 'legendary', rarity: 'legendary', after: { epicPlus: 0, legendary: 0 }, epicWaits: [4], legendaryWaits: [1] },
    { name: 'when both are due the higher tier wins and resets both', bound: guarded, before: { epicPlus: 3, legendary: 5 }, band: 'none', rarity: 'legendary', after: { epicPlus: 0, legendary: 0 }, epicWaits: [4], legendaryWaits: [6] },
    { name: 'a due Legendary guarantee raises a Rare', bound: guarded, before: { epicPlus: 0, legendary: 5 }, band: 'rare', rarity: 'legendary', after: { epicPlus: 0, legendary: 0 }, epicWaits: [1], legendaryWaits: [6] },
    { name: 'a guarantee not yet due leaves the roll alone', bound: guarded, before: { epicPlus: 2, legendary: 1 }, band: 'rare', rarity: 'rare', after: { epicPlus: 3, legendary: 2 }, epicWaits: [], legendaryWaits: [] },
  ];

  test.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const state = killState({ rng: seedWithBand(BANDS[entry.band]), protection: entry.before });
    kill(state, entry.bound);
    const rolled = state.pendingRewards.find((reward) => reward.item.kind === 'equipment');
    expect(rolled === undefined ? null : rolled.item.kind === 'equipment' ? rolled.item.rarity : null).toBe(entry.rarity);
    expect(state.dropProtection).toEqual(entry.after);
    expect(state.metrics.drops.epicPlusWaits).toEqual(entry.epicWaits);
    expect(state.metrics.drops.legendaryWaits).toEqual(entry.legendaryWaits);
  });

  test('a monster with no equipment list is no opportunity, yet its band draw is still spent', () => {
    const rng = seedWithBand(BANDS.none);
    const state = killState({ rng, protection: { epicPlus: 3, legendary: 5 } });
    expect(drawsOf(() => kill(state, bare))).toEqual([1_000_000, 1_000_000, 1]);
    expect(state.dropProtection).toEqual({ epicPlus: 3, legendary: 5 });
    expect(state.pendingRewards).toEqual([]);
  });

  test('the counters survive stop and start into the next hunt (layer-1 §4.5)', () => {
    const sim = simulation(content);
    const first = sim.stop(runTo(sim, sim.start(labInput({ seed: 5 })), 600_000).state);
    expect(first.dropProtection.epicPlus).toBeGreaterThan(0);
    const next = sim.start(labInput({ seed: 6 }), { dropProtection: first.dropProtection });
    expect(next.dropProtection).toEqual(first.dropProtection);
    expect(next.nextRewardSeq).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Disposition at encounter end (part 3 §2.1, §3.3, §3.4)
// ---------------------------------------------------------------------------

describe('disposition', () => {
  test('happens at encounter end, never at death, in ascending rewardSeq', () => {
    const sim = simulation(rich);
    let state = sim.start(labInput({ seed: 11 }), { loot: KEEP_ALL });
    // Advance event by event until a kill has rolled something mid-encounter.
    while (!state.pendingRewards.some((reward) => reward.disposition === null) && state.phase !== 'stopped') {
      state = sim.advance(state, state.nowMs + 1_000, { maxScheduledEvents: 1 }).state;
    }
    expect(state.phase).toBe('fighting');
    const waiting = state.pendingRewards.filter((reward) => reward.disposition === null).map((reward) => reward.rewardSeq);
    while (state.phase === 'fighting') state = sim.advance(state, state.nowMs + 1_000, { maxScheduledEvents: 1 }).state;
    const settled = state.pendingRewards.filter((reward) => waiting.includes(reward.rewardSeq));
    expect(settled.every((reward) => reward.disposition !== null)).toBe(true);
    expect(state.bagState.usedSlots).toBe(state.metrics.drops.kept);
  });

  test('a Keep that does not fit is lost with a drop-lost event, and the hunt continues', () => {
    const state = killState({ rng: 3, bag: { capacity: 1, usedSlots: 0, stackHeadroom: {} }, loot: KEEP_ALL });
    kill(state, rich);
    kill(state, rich);
    const rolled = state.pendingRewards.map((reward) => reward.rewardSeq);
    expect(rolled).toHaveLength(2);
    const events = settle(state, rich);
    expect(state.pendingRewards.map((reward) => reward.disposition?.outcome)).toEqual(['kept', 'lost']);
    expect(events).toEqual([expect.objectContaining({ kind: 'drop-lost', amount: rolled[1] })]);
    expect(state.metrics.drops).toMatchObject({ kept: 1, lost: 1 });
    expect(state.bagState.usedSlots).toBe(1);
    expect(state.phase).toBe('fighting');
  });

  test('a full bag never stops a hunt, and Auto-sell never takes a slot', () => {
    const sim = simulation(rich);
    const full = runTo(sim, sim.start(labInput({ seed: 21 }), { bag: { capacity: 0, usedSlots: 0, stackHeadroom: {} } }), 900_000).state;
    expect(full.stopReason).not.toBe('operator');
    expect(full.metrics.drops.lost).toBeGreaterThan(0);
    expect(full.metrics.drops.autoSold).toBeGreaterThan(0);
    expect(full.bagState.usedSlots).toBe(0);
    const outcomes = full.pendingRewards.map((reward) => [reward.item.kind === 'equipment' ? reward.item.rarity : null, reward.disposition?.outcome]);
    for (const [rarity, outcome] of outcomes) {
      if (outcome === undefined) continue;
      expect(outcome).toBe(rarity === 'common' ? 'auto-sold' : 'lost');
    }
  });

  test('consumable overflow opens a new stack in a free slot, and is otherwise lost', () => {
    const state = killState({ bag: { capacity: 2, usedSlots: 1, stackHeadroom: { 'small-hp-potion': 1 } }, loot: KEEP_ALL });
    const push = () => {
      state.pendingRewards.push({
        rewardSeq: state.nextRewardSeq++, atSimMs: state.nowMs, monsterId: 'briar-boar', itemLevel: 10,
        item: { kind: 'consumable', consumableId: 'small-hp-potion', quantity: 1 }, disposition: null,
      });
    };
    push();
    settle(state);
    expect(state.bagState).toEqual({ capacity: 2, usedSlots: 1, stackHeadroom: { 'small-hp-potion': 0 } });
    push();
    settle(state);
    expect(state.bagState).toEqual({ capacity: 2, usedSlots: 2, stackHeadroom: { 'small-hp-potion': 998 } });
    state.bagState.stackHeadroom['small-hp-potion'] = 0;
    push();
    const events = settle(state);
    expect(state.pendingRewards.at(-1)?.disposition?.outcome).toBe('lost');
    expect(events.map((event) => event.kind)).toEqual(['drop-lost']);
  });
});

// ---------------------------------------------------------------------------
// Loot apply (part 3 §3.3; UI spec §6): only drops after the cutoff
// ---------------------------------------------------------------------------

describe('applying a loot filter', () => {
  const sim = simulation(rich);

  test('governs only rewards rolled after the cutoff; earlier ones keep the filter they were rolled under', () => {
    const state = killState({ rng: 3, loot: KEEP_ALL });
    kill(state, rich);
    const applied = sim.queueLoot(state, IGNORE_ALL);
    expect(applied.pendingLoot.map((pending) => pending.fromRewardSeq)).toEqual([state.nextRewardSeq]);
    expect(applied.lootPresetSnapshot).toEqual(KEEP_ALL);
    kill(applied, rich);
    settle(applied, rich);
    expect(applied.pendingRewards.map((reward) => reward.disposition?.action)).toEqual(['keep', 'ignore']);
    // Once nothing earlier waits, the applied filter is the snapshot.
    expect(applied.pendingLoot).toEqual([]);
    expect(applied.lootPresetSnapshot).toEqual(IGNORE_ALL);
  });

  test('takes effect at once when nothing is waiting, never touches a settled reward, and is a deep copy', () => {
    const state = killState({ rng: 3, loot: KEEP_ALL });
    kill(state, rich);
    settle(state, rich);
    const preset = structuredClone(IGNORE_ALL);
    const applied = sim.queueLoot(state, preset);
    preset.fallback.equipment = 'keep';
    expect(applied.pendingLoot).toEqual([]);
    expect(applied.lootPresetSnapshot).toEqual(IGNORE_ALL);
    expect(applied.pendingRewards[0].disposition?.action).toBe('keep');
    expect(applied.rng).toBe(state.rng);
  });

  test('two applies inside one encounter each keep their own window; a later apply never takes an earlier window back', () => {
    const SELL_ALL: LootPreset = { exceptions: [], rarity: {}, fallback: { equipment: 'auto-sell', consumable: 'auto-sell' } };
    const IGNORE_GEAR: LootPreset = { exceptions: [], rarity: {}, fallback: { equipment: 'ignore', consumable: 'keep' } };
    let state = killState({ rng: 3, loot: KEEP_ALL });
    kill(state, rich);                                // r0 under the snapshot
    state = sim.queueLoot(state, SELL_ALL);           // A from r1
    kill(state, rich);                                // r1 under A
    state = sim.queueLoot(state, IGNORE_ALL);         // B from r2
    // No reward rolled since B: its window is empty, so this apply replaces it.
    state = sim.queueLoot(state, IGNORE_GEAR);
    expect(state.pendingLoot.map((pending) => pending.fromRewardSeq)).toEqual([1, 2]);
    expect(state.pendingLoot.map((pending) => pending.preset)).toEqual([SELL_ALL, IGNORE_GEAR]);

    // The windows survive a checkpoint round trip.
    const grid = createGrid(rich.grid, rich.shapes);
    state = decodeSnapshot(encodeSnapshot(state), rich, grid);
    kill(state, rich);                                // r2 under the replacement
    settle(state, rich);
    expect(state.pendingRewards.map((reward) => [reward.rewardSeq, reward.disposition?.action])).toEqual([
      [0, 'keep'], [1, 'auto-sell'], [2, 'ignore'],
    ]);
    expect(state.pendingLoot).toEqual([]);
    expect(state.lootPresetSnapshot).toEqual(IGNORE_GEAR);
  });

  test('pending filter windows are bounded and strictly ascending in a decoded checkpoint', () => {
    const grid = createGrid(rich.grid, rich.shapes);
    const state = killState({ rng: 3, loot: KEEP_ALL });
    kill(state, rich);
    kill(state, rich);
    const refuse = (pendingLoot: SimState['pendingLoot']) => {
      try {
        decodeSnapshot(encodeSnapshot({ ...structuredClone(state), contentVersion: rich.version, pendingLoot }), rich, grid);
      } catch (error) {
        return (error as SimError).field;
      }
      return null;
    };
    expect(refuse([{ preset: IGNORE_ALL, fromRewardSeq: 1 }, { preset: KEEP_ALL, fromRewardSeq: 2 }])).toBeNull();
    expect(refuse([{ preset: IGNORE_ALL, fromRewardSeq: 1 }, { preset: KEEP_ALL, fromRewardSeq: 1 }])).toBe('pendingLoot.1.fromRewardSeq');
    expect(refuse([{ preset: IGNORE_ALL, fromRewardSeq: 3 }])).toBe('pendingLoot.0.fromRewardSeq');
    const tooMany = Array.from({ length: 2 * rich.grid.maxEnemies + 2 }, (_, index) => ({ preset: IGNORE_ALL, fromRewardSeq: index }));
    expect(refuse(tooMany)).toBe('pendingLoot');
  });

  test('refuses an invalid filter with a bounded field', () => {
    const state = killState();
    expect(() => sim.queueLoot(state, { ...STARTER_LOOT_PRESET, fallback: {} } as unknown as LootPreset))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT', field: 'loot.fallback.equipment' }));
  });
});

// ---------------------------------------------------------------------------
// Checkpoints (part 2 §2, part 3 §2.5)
// ---------------------------------------------------------------------------

describe('the checkpoint carries what a replay needs', () => {
  const sim = simulation(rich);

  test('drops are identical whether a hunt is advanced in one segment or many (split invariance)', () => {
    const input = labInput({ seed: 31 });
    const whole = runTo(sim, sim.start(input), 1_800_000).state;
    expect(whole.nextRewardSeq).toBeGreaterThan(20);
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 1_799_999 }), { maxLength: 6 }), (cuts) => {
        let state = sim.start(input);
        for (const at of [...cuts].sort((a, b) => a - b)) state = runTo(sim, state, at).state;
        state = runTo(sim, state, 1_800_000).state;
        expect(encodeSnapshot(state)).toBe(encodeSnapshot(whole));
      }),
      { numRuns: 8 },
    );
  });

  test('draining dispositioned rewards between segments changes nothing that follows', () => {
    const input = labInput({ seed: 32 });
    const whole = runTo(sim, sim.start(input), 1_200_000).state;
    let state = sim.start(input);
    const drained: unknown[] = [];
    for (const at of [200_000, 450_000, 700_000, 1_200_000]) {
      const taken = takeDispositionedRewards(runTo(sim, state, at).state);
      drained.push(...taken.rewards);
      state = sim.decode(sim.encode(taken.state));
    }
    const { state: wholeRest, rewards: wholeRewards } = takeDispositionedRewards(whole);
    expect(drained).toEqual(wholeRewards);
    expect(encodeSnapshot(state)).toBe(encodeSnapshot(wholeRest));
  });

  test('a snapshot with rewards round-trips byte-identically', () => {
    const state = runTo(sim, sim.start(labInput({ seed: 33 })), 400_000).state;
    expect(state.pendingRewards.length).toBeGreaterThan(0);
    const text = encodeSnapshot(state);
    expect(encodeSnapshot(decodeSnapshot(text, rich, createGrid(rich.grid, rich.shapes)))).toBe(text);
  });

  test("an A-era snapshot is refused: 'a1', and a b1 shape without the reward fields", () => {
    const grid = createGrid(rich.grid, rich.shapes);
    const raw = JSON.parse(encodeSnapshot(sim.start(labInput()))) as Record<string, unknown>;
    const refuse = (mutate: (value: Record<string, unknown>) => void) => {
      const copy = structuredClone(raw);
      mutate(copy);
      try {
        decodeSnapshot(JSON.stringify(copy), rich, grid);
      } catch (error) {
        return { code: (error as SimError).code, field: (error as SimError).field };
      }
      throw new Error('expected a refusal');
    };
    expect(refuse((value) => { value.simulationVersion = 'a1'; })).toEqual({ code: 'WRONG_VERSION', field: 'simulationVersion' });
    expect(refuse((value) => { delete value.nextRewardSeq; })).toMatchObject({ field: 'nextRewardSeq' });
    expect(refuse((value) => { delete (value.metrics as Record<string, unknown>).drops; })).toMatchObject({ field: 'metrics.drops' });
    expect(refuse((value) => { delete value.lootPresetSnapshot; })).toMatchObject({ field: 'lootPresetSnapshot' });
    expect(refuse((value) => { delete value.bagState; })).toMatchObject({ field: 'bagState' });
    expect(refuse((value) => { delete value.dropProtection; })).toMatchObject({ field: 'dropProtection' });
  });

  test('refuses a reward ledger out of order, an impossible outcome, or a reward the bag rules cannot produce', () => {
    const grid = createGrid(rich.grid, rich.shapes);
    const state = runTo(sim, sim.start(labInput({ seed: 34 })), 400_000).state;
    expect(state.pendingRewards.length).toBeGreaterThan(1);
    const field = (mutate: (value: SimState) => void) => {
      const copy = structuredClone(state);
      mutate(copy);
      try {
        decodeSnapshot(encodeSnapshot(copy), rich, grid);
      } catch (error) {
        return (error as SimError).field;
      }
      return null;
    };
    expect(field((value) => value.pendingRewards.reverse())).toBe('pendingRewards.1.rewardSeq');
    expect(field((value) => { value.nextRewardSeq = 0; })).toBe('pendingRewards.0.rewardSeq');
    expect(field((value) => {
      value.pendingRewards[0].disposition = { action: 'ignore', matched: 'default', outcome: 'lost' };
    })).toBe('pendingRewards.0.disposition.outcome');
    expect(field((value) => { value.pendingRewards[0].disposition = null; })).toBe('pendingRewards.1.disposition');
    expect(field((value) => { value.bagState.usedSlots = value.bagState.capacity + 1; })).toBe('bagState.usedSlots');
  });
});
