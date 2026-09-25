export type ClassId = 'guardian' | 'cleric' | 'ranger' | 'arcanist';
export type SkillId = 'taunt' | 'cleave' | 'heal' | 'smite'
  | 'double-shot' | 'arrow-rain' | 'fire-bolt' | 'frost-nova';
export type RecipeId = 'melee' | 'ranged' | 'clustered';
export type Element = 'neutral' | 'fire' | 'water' | 'earth' | 'wind';
export type Family = 'beast' | 'undead' | 'demon' | 'plant' | 'insect' | 'humanoid';
export type ShapeId = 'single' | 'cleave' | 'square' | 'plus';
export type DamageKind = 'physical' | 'magic';
export interface Attributes {
  str: number; agi: number; vit: number; int: number; dex: number; luk: number;
}
export interface GridConfig {
  width: number; height: number; playerRows: number[]; enemyRows: number[];
  moveMs: number; maxEnemies: number;
}
export interface ClassDefinition {
  id: ClassId; attributes: Attributes; level: number;
  baseHp: number; hpPerLevel: number; baseMp: number; mpPerLevel: number;
  weaponAtk: number; weaponMatk: number; armorDef: number; armorMdef: number;
  basicIntervalMs: number; basicRange: number; basicKind: DamageKind;
  skills: SkillId[];
}
export interface SkillDefinition {
  id: SkillId; mp: number; cooldownMs: number; baseCastMs: number;
  range: number; shape: ShapeId; powerBp: number; hits: number;
  effect: 'damage' | 'heal' | 'taunt'; damageKind: DamageKind;
  element: Element; slowBp: number; durationMs: number;
}
export interface MonsterDefinition {
  id: string; level: number; family: Family; element: Element;
  hp: number; mp: number; atk: number; matk: number; def: number; mdef: number;
  hit: number; flee: number; intervalMs: number; range: number;
  rawExp: number; rawGold: number;
}
export interface RecipeDefinition {
  id: RecipeId; weight: number;
  monsters: { monsterId: string; column: number; row: number }[];
}
export interface Content {
  version: string; gridHash: string; grid: GridConfig;
  classes: Record<ClassId, ClassDefinition>;
  skills: Record<SkillId, SkillDefinition>;
  monsters: Record<string, MonsterDefinition>;
  recipes: Record<RecipeId, RecipeDefinition>;
  shapes: Record<ShapeId, [number, number][]>;
  elements: Record<Element, Record<Element, number>>;
  walkMs: number; regenMs: number; encounterLimitMs: number; respawnMs: number;
  /**
   * Duration of the simulated travel segment a stop consumes on its way back to
   * town (owner decision 2026-09-21, spec §4.0; ruling R114). OPEN CONTENT INPUT:
   * `null` until the owner chooses the number — neither layer-1 nor the
   * milestone B parts give one, and part 3 §8 #9 only bounds it below by the
   * map's walk interval. Nothing may substitute a default for it.
   */
  townReturnTravelMs: number | null;
}
