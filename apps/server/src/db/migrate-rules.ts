/**
 * The rules migration applies to derived values (layer-1 §4.7 step 4).
 *
 * Pure and separate from the runbook that calls them, so each is decided by a
 * test rather than by the shape of a migration script.
 */

/**
 * The owner's HP/MP rule, decided 2026-09-21 (spec §4.0, part 1 §9 #16, part 3
 * §8 #12): **preserve the current value and clamp it to the new maximum.**
 *
 * Ratio preservation was the alternative and was rejected: it heals a party
 * whose maximum rises and harms one whose maximum falls, which would make
 * maintenance the one transition that grants free recovery — the thing
 * layer-1 §4.5 forbids everywhere else. The same rule applies at level-up, on
 * equip and unequip, at respec and in migration, so no path becomes a
 * healing trick.
 */
export function clampToMaximum(current: number, maximum: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(maximum)) {
    throw new RangeError('hp/mp adjustment requires finite values');
  }
  const ceiling = Math.max(0, Math.trunc(maximum));
  return Math.min(Math.max(0, Math.trunc(current)), ceiling);
}
