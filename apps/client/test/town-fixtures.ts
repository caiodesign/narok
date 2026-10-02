/**
 * Account fixtures for the town screens' suites. Every figure here is a test
 * input, not content: the screens read the same shapes from the server.
 */
import { content, type Content, type ItemInstance } from '@narok/data';
import type { CharacterSummary, InventoryResponse, LootPresetRecord } from '../src/commands';

export const ACCOUNT = 'a0000000-0000-4000-8000-000000000001';
export const BJORN = '00000000-0000-4000-8000-000000000001';
export const SIGRUN = '00000000-0000-4000-8000-000000000002';
export const KAIO = '00000000-0000-4000-8000-000000000003';
export const LOOT_PRESET = '30000000-0000-4000-8000-000000000001';

let serial = 0;
export function item(overrides: Partial<ItemInstance> = {}): ItemInstance {
  serial += 1;
  return {
    id: `10000000-0000-4000-9000-${String(serial).padStart(12, '0')}`,
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

export function character(overrides: Partial<CharacterSummary> & Pick<CharacterSummary, 'id' | 'slot' | 'name' | 'classId'>): CharacterSummary {
  return {
    level: 2,
    exp: 10,
    expToNext: 100,
    attributes: { str: 1, agi: 5, vit: 3, int: 1, dex: 11, luk: 1 },
    statPoints: 7,
    skillPoints: 1,
    skillRanks: {},
    autoSpendTemplate: null,
    hp: 50,
    mp: 20,
    maxHp: 60,
    maxMp: 30,
    stats: { maxHp: 60, maxMp: 30, atk: 21, matk: 4, def: 6, mdef: 2, hit: 30, flee: 12, critBp: 300, intervalMs: 1500 },
    ...overrides,
  };
}

export const PARTY: readonly CharacterSummary[] = [
  character({ id: BJORN, slot: 0, name: 'Bjorn', classId: 'guardian' }),
  character({ id: SIGRUN, slot: 1, name: 'Sigrun', classId: 'cleric' }),
  character({ id: KAIO, slot: 2, name: 'Kaio', classId: 'ranger' }),
];

export function bag(items: ItemInstance[], extra: Partial<InventoryResponse> = {}): InventoryResponse {
  const consumables = extra.consumables ?? [{ consumableId: 'small-hp-potion', quantity: 20, stacks: 1 }];
  return {
    capacity: 12,
    usedSlots: items.filter((entry) => entry.equipped === null).length + consumables.reduce((sum, stack) => sum + stack.stacks, 0),
    gold: 120,
    stateVersion: 7,
    items,
    consumables,
    ...extra,
  };
}

export const LOOT: readonly LootPresetRecord[] = [
  {
    id: LOOT_PRESET,
    name: 'Default',
    presetVersion: 2,
    payloadSchemaVersion: 1,
    payload: {
      exceptions: [{ when: { category: 'consumable' }, action: 'keep' }],
      rarity: { common: 'auto-sell', uncommon: 'keep' },
      fallback: { equipment: 'keep', consumable: 'keep' },
    },
  },
];

/** Content with one definition's level requirement raised, for the under-level case. */
export function contentRequiring(definitionId: string, level: number): Content {
  return { ...content, items: { ...content.items, [definitionId]: { ...content.items[definitionId]!, levelRequirement: level } } };
}
