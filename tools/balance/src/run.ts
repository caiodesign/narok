import { content } from '@narok/data';
import type { ClassId, RecipeId } from '@narok/data';
import { createGrid, createSimulation, defaultStrategy } from '@narok/sim';
import type { ActorId, AdvanceOptions, LabInput, SimState, Simulation, Strategy } from '@narok/sim';
import { buildPlacement, formatPlacement } from './placement';
import type { PlacementName, RunResult } from './types';

/** The one real-content `Simulation` every run/matrix job shares (rulings R48). */
const battlefield = createGrid(content.grid, content.shapes);
const sim: Simulation = createSimulation(content, battlefield);

/** Class multiset generation order (rulings R48): the roster/validation class order. */
const CLASS_ORDER: readonly ClassId[] = ['guardian', 'cleric', 'ranger', 'arcanist'];
/** Matrix's three fixed recipes (spec §12) — never `'mixed'`. */
const MATRIX_RECIPES: readonly RecipeId[] = ['melee', 'ranged', 'clustered'];
/** Matrix's three placements (spec §12), in this stable order. */
const MATRIX_PLACEMENTS: readonly PlacementName[] = ['default', 'front', 'spread'];

/**
 * Fixed rest thresholds and wipe limit every run/matrix job uses (rulings R48). Never
 * user-configurable in this CLI surface.
 */
const REST = { hpStart: 50, mpStart: 30 };
const WIPE_LIMIT = 1;

/**
 * Builds an explicit `LabInput` (rulings R48): the parsed roster in class order
 * (`p0`…), each class's own default strategy, fixed rest/wipe-limit, the chosen
 * recipe/seed, and the named placement.
 */
export function buildLabInput(
  seed: number,
  classes: ClassId[],
  recipe: LabInput['recipe'],
  placementName: PlacementName,
): LabInput {
  const strategies: Record<ActorId, Strategy> = {};
  classes.forEach((classId, index) => {
    strategies[`p${index}`] = defaultStrategy(classId);
  });
  return {
    seed,
    classes: [...classes],
    recipe,
    placement: buildPlacement(placementName, classes),
    strategies,
    rest: { ...REST },
    wipeLimit: WIPE_LIMIT,
  };
}

/**
 * Drives one experiment to `untilMs` in summary collection mode, draining every
 * work-budget yield to the same absolute target without retaining domain logs
 * (contract §6 `runTo`, adapted for summary collection per rulings R48). Throws if an
 * iteration reports no progress, so a budget that cannot advance fails loudly instead
 * of looping forever.
 */
export function drainSummary(
  simulation: Simulation,
  state: SimState,
  untilMs: number,
  options?: Omit<AdvanceOptions, 'collect'>,
): SimState {
  let current = state;
  for (;;) {
    const beforeNowMs = current.nowMs;
    const beforePopped = current.nextQueueSeq - current.queue.length;
    const result = simulation.advance(current, untilMs, { ...options, collect: 'summary' });
    current = result.state;
    if (result.reachedTarget) return current;
    const afterPopped = current.nextQueueSeq - current.queue.length;
    if (current.nowMs <= beforeNowMs && afterPopped <= beforePopped) {
      throw new Error(`advance made no progress at ${current.nowMs} ms toward ${untilMs} ms`);
    }
  }
}

/**
 * One seed's waits as a distribution (layer-1 §12): the completed waits in
 * order, then the open one as `>n` when the run ended partway into a wait.
 * Never averaged — a mean over a long-tailed wait hides exactly the tail the
 * bad-luck thresholds are chosen from.
 */
export function formatWaits(completed: readonly number[], open: number): string {
  const parts = completed.map(String);
  if (open > 0) parts.push(`>${open}`);
  return parts.join(';');
}

function runOne(input: LabInput, untilMs: number): RunResult {
  const started = sim.start(input);
  const final = drainSummary(sim, started, untilMs);
  const elapsedMs = final.nowMs;
  const killsPerHour = elapsedMs === 0 ? null : (final.metrics.kills * 3_600_000) / elapsedMs;
  const drops = final.metrics.drops;

  return {
    simulation_version: final.simulationVersion,
    content_version: final.contentVersion,
    seed: input.seed,
    roster: input.classes.join(','),
    recipe: input.recipe,
    placement: formatPlacement(input.placement),
    requested_ms: untilMs,
    elapsed_ms: elapsedMs,
    stop_reason: final.stopReason,
    kills: final.metrics.kills,
    wins: final.metrics.wins,
    wipes: final.metrics.wipes,
    rest_ms: final.metrics.restMs,
    walk_ms: final.metrics.walkMs,
    fight_ms: final.metrics.fightMs,
    raw_exp: final.metrics.rawExp,
    raw_gold: final.metrics.rawGold,
    damage_dealt: final.metrics.damageDealt,
    effective_healing: final.metrics.effectiveHealing,
    kills_per_hour: killsPerHour,
    items_rolled_common: drops.rolled.common,
    items_rolled_uncommon: drops.rolled.uncommon,
    items_rolled_rare: drops.rolled.rare,
    items_rolled_epic: drops.rolled.epic,
    items_rolled_legendary: drops.rolled.legendary,
    items_kept: drops.kept,
    items_autosold: drops.autoSold,
    drops_lost: drops.lost,
    first_drop_ms: drops.firstDropMs,
    first_drop_rarity: drops.firstDropRarity,
    epic_wait_kills: formatWaits(drops.epicPlusWaits, final.dropProtection.epicPlus),
    legendary_wait_kills: formatWaits(drops.legendaryWaits, final.dropProtection.legendary),
    drop_protection: { ...final.dropProtection },
    metrics: final.metrics,
  };
}

/**
 * Runs `input` once per seed (rulings R48, task 8 brief), overriding only `seed` on
 * each iteration so identical seeds reproduce byte-identical `RunResult`s. Summary
 * collection mode never retains domain logs.
 */
export function runBatch(input: LabInput, seeds: number[], untilMs: number): RunResult[] {
  return seeds.map((seed) => runOne({ ...input, seed }, untilMs));
}

/**
 * Every unordered class multiset of size 1–3 (rulings R48), built from
 * non-decreasing indexes into {@link CLASS_ORDER} so ordering never multiplies an
 * equivalent composition. Exactly 34 for four classes: C(4,1) + C(5,2) + C(6,3) =
 * 4 + 10 + 20.
 */
export function classMultisets(): ClassId[][] {
  const n = CLASS_ORDER.length;
  const results: ClassId[][] = [];

  function build(size: number, start: number, current: number[]): void {
    if (current.length === size) {
      results.push(current.map((index) => CLASS_ORDER[index]));
      return;
    }
    for (let index = start; index < n; index++) build(size, index, [...current, index]);
  }

  for (let size = 1; size <= 3; size++) build(size, 0, []);
  return results;
}

/**
 * Enumerates all 34 class multisets × 3 fixed recipes × 3 placements, in that stable
 * order, running every `seed` for each composition (rulings R48, spec §12).
 */
export function runMatrix(seeds: number[], untilMs: number): RunResult[] {
  const rows: RunResult[] = [];
  for (const classes of classMultisets()) {
    for (const recipe of MATRIX_RECIPES) {
      for (const placementName of MATRIX_PLACEMENTS) {
        for (const seed of seeds) {
          rows.push(runOne(buildLabInput(seed, classes, recipe, placementName), untilMs));
        }
      }
    }
  }
  return rows;
}
