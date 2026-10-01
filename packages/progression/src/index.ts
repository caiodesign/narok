/**
 * `@narok/progression` — the pure town and progression rules (milestone B
 * Part 3 §3–§6). No I/O, no clock, no randomness: the server's town commands
 * and the simulation's mid-hunt level-ups import the same functions, so no
 * formula exists twice. Every command returns `{ ok: true, next }` or one
 * `{ ok: false, code, field }` (ruling R133).
 */
export * from './types';
export {
  EXP_SHARE_DENOMINATOR, awardLevels, createCharacter, createProgress, expToNext, gainExp, pointBudget, splitExp,
  statCost, statStepCost,
} from './levels';
export {
  applyAllocation, autoSpend, respec, revalidateRules, setAutoSpendTemplate, upgradeSkill, validateAutoSpendTemplate,
} from './allocation';
export type { RespecScope } from './allocation';
export { clampResources } from './resources';
export { equip, unequip } from './equip';
export { bagLock, bagPlace, bagPlaceConsumable, bagState, consumePotion, consumePotions, usedSlots } from './bag';
export type { PotionUser } from './bag';
export { ONBOARDING_GRANT_KEY, grantOnboarding, grantStarterKit, starterKitKey } from './grants';
export type { GrantLedger, GrantOutcome } from './grants';
