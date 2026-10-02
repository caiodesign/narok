// @vitest-environment jsdom
/**
 * The Bag screen (milestone B Task 10; part 4 §3.3; UI spec §6).
 *
 * B-12: search, category tab, sort, select, pin and unpin are functional, and
 * an item is compared against a real eligible character's real equipped slot
 * with signed deltas, restrictions and an empty-slot case. B-13 (client
 * half): equip is disabled while hunting with "Return to town to equip", and
 * under-level states both levels. B-15 (client half, ruling R185): every sale
 * control sits behind `VITE_FEATURE_SHOP`, off by default; with it on, a
 * locked item is excluded from a bulk sale and its own sale refused until it
 * is unlocked, and the preview counts items and slots — never gold.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { content, type Content, type ItemInstance } from '@narok/data';
import { CommandError, type CharacterSummary, type InventoryResponse, type LootPresetRecord } from '../src/commands';
import i18n from '../src/i18n';
import en from '../src/locales/en.json';
import { BagScreen, type BagCommands } from '../src/town/BagScreen';
import { SALE_KIT } from '../src/town/SaleControls';
import { bag, contentRequiring, item, KAIO, LOOT, PARTY } from './town-fixtures';

afterEach(() => {
  cleanup();
});

function commands(): BagCommands & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    equip: vi.fn(async (...args: unknown[]) => {
      calls.push(['equip', ...args]);
    }),
    lock: vi.fn(async (...args: unknown[]) => {
      calls.push(['lock', ...args]);
    }),
    applyLoot: vi.fn(async (...args: unknown[]) => {
      calls.push(['applyLoot', ...args]);
    }),
    sell: vi.fn(async (...args: unknown[]) => {
      calls.push(['sell', ...args]);
    }),
  };
}

function mount(options: {
  inventory: InventoryResponse;
  characters?: readonly CharacterSummary[];
  hunting?: boolean;
  shopEnabled?: boolean;
  content?: Content;
  lootPresets?: readonly LootPresetRecord[];
  activeLootId?: string | null;
  pendingLootId?: string | null;
  commands?: BagCommands & { calls: unknown[][] };
}) {
  const held = options.commands ?? commands();
  const element = (presets: readonly LootPresetRecord[]) => (
    <BagScreen
      content={options.content ?? content}
      inventory={options.inventory}
      characters={options.characters ?? PARTY}
      lootPresets={presets}
      activeLootId={options.activeLootId ?? null}
      pendingLootId={options.pendingLootId ?? null}
      hunting={options.hunting ?? false}
      zone="prototype"
      commands={held}
      sale={options.shopEnabled === true ? SALE_KIT : null}
      onBack={() => undefined}
    />
  );
  const view = render(element(options.lootPresets ?? LOOT));
  return { ...view, commands: held, rerenderPresets: (presets: readonly LootPresetRecord[]) => view.rerender(element(presets)) };
}

const name = (definitionId: string) => i18n.t(`item.${definitionId}`);
const cells = () => screen.getAllByRole('button', { name: /,/ }).filter((node) => node.classList.contains('item'));
const tip = () => document.querySelector('.itemtip') as HTMLElement;

describe('B-12: the grid is searchable, filterable and sortable', () => {
  const bow = item({ definitionId: 'ranger-bow', rarity: 'epic', itemLevel: 9 });
  const cap = item({ definitionId: 'leather-cap', rarity: 'uncommon', itemLevel: 4 });
  const cloak = item({ definitionId: 'wool-cloak', rarity: 'common', itemLevel: 6 });
  const inventory = bag([cloak, bow, cap]);

  test('the category tabs are All, Equipment and Consumables, with counts; no Materials', () => {
    mount({ inventory });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      `${en.bag.category.all}4`,
      `${en.bag.category.equipment}3`,
      `${en.bag.category.consumable}1`,
    ]);
    expect(screen.queryByText(/materials/i)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(en.bag.category.consumable) }));
    expect(cells().map((cell) => cell.getAttribute('aria-label'))).toEqual([expect.stringContaining(i18n.t('consumable.small-hp-potion'))]);
  });

  test('search narrows by name', () => {
    mount({ inventory });
    fireEvent.change(screen.getByRole('searchbox', { name: en.bag.search }), { target: { value: name('leather-cap').slice(0, 4) } });
    expect(cells()).toHaveLength(1);
    expect(cells()[0]).toHaveAccessibleName(expect.stringContaining(name('leather-cap')));
  });

  test('sort cycles rarity, item level and name', () => {
    mount({ inventory });
    const order = () => cells().map((cell) => cell.getAttribute('aria-label')!.split(',')[0]);
    expect(order().slice(0, 3)).toEqual([name('ranger-bow'), name('leather-cap'), name('wool-cloak')]);
    const sort = screen.getByRole('button', { name: new RegExp(en.bag.sort) });
    fireEvent.click(sort);
    expect(sort).toHaveTextContent(en.bag.sortBy.level);
    expect(order().slice(0, 3)).toEqual([name('ranger-bow'), name('wool-cloak'), name('leather-cap')]);
    fireEvent.click(sort);
    expect(sort).toHaveTextContent(en.bag.sortBy.name);
  });

  test('empty cells fill the rest of the server’s capacity; no expansion slots are offered', () => {
    mount({ inventory });
    expect(document.querySelectorAll('.cell--empty')).toHaveLength(inventory.capacity - inventory.usedSlots);
    expect(document.querySelector('.expansion')).toBeNull();
    expect(document.querySelector('.cell--locked')).toBeNull();
  });

  test('select shows the tip; pin keeps it; unpin releases it', () => {
    mount({ inventory });
    fireEvent.click(cells()[0]!);
    expect(cells()[0]).toHaveAttribute('aria-pressed', 'true');
    expect(within(tip()).getByRole('heading', { name: name('ranger-bow') })).toBeInTheDocument();

    fireEvent.click(within(tip()).getByRole('button', { name: en.bag.pin }));
    expect(within(tip()).getByText(en.bag.pinned)).toBeInTheDocument();
    fireEvent.click(cells()[1]!);
    expect(within(tip()).getByRole('heading', { name: name('ranger-bow') })).toBeInTheDocument();

    fireEvent.click(within(tip()).getByRole('button', { name: en.bag.unpin }));
    expect(within(tip()).getByRole('heading', { name: name('leather-cap') })).toBeInTheDocument();
  });
});

describe('B-12: comparison against a real character and slot', () => {
  test('signed deltas against what the eligible character wears', () => {
    const worn = item({ definitionId: 'ranger-bow', bonuses: [{ bonusId: 'dex', value: 3 }], equipped: { characterId: KAIO, slot: 'weapon' } });
    const candidate = item({ definitionId: 'ranger-bow', rarity: 'uncommon', bonuses: [{ bonusId: 'dex', value: 1 }] });
    mount({ inventory: bag([worn, candidate]) });
    fireEvent.click(cells()[0]!);
    // The bow is a ranger's: the eligible character is chosen, not the first in the roster.
    expect(within(tip()).getByRole('combobox', { name: en.bag.compareWith })).toHaveValue(KAIO);
    const table = within(tip()).getByRole('table');
    const dex = within(table).getByRole('row', { name: new RegExp(i18n.t('bonus.dex')) });
    expect(dex).toHaveTextContent('+3');
    expect(dex).toHaveTextContent('+1');
    expect(within(dex).getByText('−2')).toHaveClass('loss');
  });

  test('an empty target slot is said so, and every line is a gain', () => {
    const candidate = item({ definitionId: 'leather-cap', bonuses: [{ bonusId: 'luk', value: 2 }] });
    mount({ inventory: bag([candidate]) });
    fireEvent.click(cells()[0]!);
    expect(within(tip()).getByText(i18n.t('bag.emptySlot', { name: 'Bjorn', slot: i18n.t('slot.head') }))).toBeInTheDocument();
    expect(within(tip()).getAllByText(/^\+/).length).toBeGreaterThan(0);
    expect(tip().querySelectorAll('td.loss')).toHaveLength(0);
  });

  test('a class restriction is stated for a character who cannot use the item', () => {
    const mace = item({ definitionId: 'cleric-mace' });
    mount({ inventory: bag([mace]) });
    fireEvent.click(cells()[0]!);
    fireEvent.change(within(tip()).getByRole('combobox', { name: en.bag.compareWith }), { target: { value: KAIO } });
    expect(within(tip()).getByText(i18n.t('bag.block.class', { classes: i18n.t('class.cleric') }))).toBeInTheDocument();
    expect(within(tip()).getByRole('button', { name: en.bag.cannotEquip })).toBeDisabled();
  });
});

describe('B-13: equip eligibility', () => {
  test('while hunting, equip is disabled and says why', () => {
    const cap = item({ definitionId: 'leather-cap' });
    const held = mount({ inventory: bag([cap]), hunting: true });
    fireEvent.click(cells()[0]!);
    const equip = within(tip()).getByRole('button', { name: en.bag.block.hunting });
    expect(equip).toBeDisabled();
    fireEvent.click(equip);
    expect(held.commands.calls).toEqual([]);
  });

  test('under-level states the required and the current level', () => {
    const cap = item({ definitionId: 'leather-cap' });
    mount({ inventory: bag([cap]), content: contentRequiring('leather-cap', 9) });
    fireEvent.click(cells()[0]!);
    const said = i18n.t('bag.block.level', { required: 9, name: 'Bjorn', current: 2 });
    expect(within(tip()).getByText(said)).toBeInTheDocument();
    expect(within(tip()).getByRole('button', { name: i18n.t('bag.requires', { level: 9 }) })).toBeDisabled();
  });

  test('in town an eligible item equips into the compared character’s slot', async () => {
    const cap = item({ definitionId: 'leather-cap' });
    const held = mount({ inventory: bag([cap]) });
    fireEvent.click(cells()[0]!);
    await act(async () => {
      fireEvent.click(within(tip()).getByRole('button', { name: i18n.t('bag.equipOn', { name: 'Bjorn' }) }));
    });
    expect(held.commands.calls).toEqual([['equip', cap.id, PARTY[0]!.id, 'head']]);
  });

  test('lock and unlock are the server’s command, allowed while hunting', async () => {
    const cap = item({ definitionId: 'leather-cap' });
    const held = mount({ inventory: bag([cap]), hunting: true });
    fireEvent.click(cells()[0]!);
    await act(async () => {
      fireEvent.click(within(tip()).getByRole('button', { name: en.bag.lock }));
    });
    expect(held.commands.calls).toEqual([['lock', cap.id, true]]);
  });
});

describe('B-15 (client half): sale controls, behind the shop flag', () => {
  const plain = item({ rarity: 'common' });
  const other = item({ rarity: 'common', definitionId: 'wool-cloak' });
  const locked = item({ rarity: 'common', definitionId: 'leather-boots', locked: true });

  test('with the flag off — the default — no sale control exists', () => {
    mount({ inventory: bag([plain, locked]) });
    expect(document.querySelector('.bulk')).toBeNull();
    fireEvent.click(cells()[0]!);
    expect(within(tip()).queryByRole('button', { name: en.bag.sell })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d\s*g\b|gold value|price/i);
  });

  test('with it on, the bulk preview excludes the locked item and counts slots, not gold', () => {
    mount({ inventory: bag([plain, other, locked]), shopEnabled: true });
    const bulk = document.querySelector('.bulk') as HTMLElement;
    expect(bulk).toHaveTextContent(i18n.t('bag.bulk.meta', { count: 2, slots: 2, locked: 1 }));
    expect(bulk.querySelector('.sold-value')).toBeNull();
  });

  test('with it on, a locked item’s own sale is refused until it is unlocked', () => {
    mount({ inventory: bag([locked]), shopEnabled: true });
    fireEvent.click(cells()[0]!);
    expect(within(tip()).getByRole('button', { name: en.bag.unlockToSell })).toBeDisabled();
  });
});

describe('the filter pane', () => {
  test('the rarity draft is local, marked edited, previewed through the evaluator, and revertable', () => {
    const cloak = item({ definitionId: 'wool-cloak', rarity: 'common' });
    mount({ inventory: bag([cloak]) });
    const filter = document.querySelector('.filter') as HTMLElement;
    expect(within(filter).queryByText(en.bag.filter.edited)).toBeNull();
    const common = within(filter).getByRole('radiogroup', { name: i18n.t('rarity.common') });
    expect(within(common).getByRole('radio', { name: en.loot.action['auto-sell'] })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(common).getByRole('radio', { name: en.loot.action.keep }));
    expect(within(filter).getByText(en.bag.filter.edited)).toBeInTheDocument();
    const row = filter.querySelector('.preview .drop') as HTMLElement;
    expect(row).toHaveClass('drop--changed');
    expect(row).toHaveTextContent(en.loot.action.keep);
    fireEvent.click(within(filter).getByRole('button', { name: en.bag.filter.revert }));
    expect(within(filter).queryByText(en.bag.filter.edited)).toBeNull();
  });

  test('Apply sends the saved version to the running hunt, and only while the draft is clean', async () => {
    const held = mount({ inventory: bag([]), hunting: true });
    const filter = document.querySelector('.filter') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(filter).getByRole('button', { name: en.bag.filter.apply }));
    });
    expect(held.commands.calls).toEqual([['applyLoot', { presetId: LOOT[0]!.id, presetVersion: LOOT[0]!.presetVersion }]]);
    const common = within(filter).getByRole('radiogroup', { name: i18n.t('rarity.common') });
    fireEvent.click(within(common).getByRole('radio', { name: en.loot.action.ignore }));
    expect(within(filter).getByRole('button', { name: en.bag.filter.apply })).toBeDisabled();
  });
});

describe('the filter pane names the active filter and keeps drafts (I1, Minor 2)', () => {
  const ALPHA: LootPresetRecord = { ...LOOT[0]!, name: 'Alpha' };
  const BETA: LootPresetRecord = { ...LOOT[0]!, id: '30000000-0000-4000-8000-000000000002', name: 'Beta' };
  const filter = () => document.querySelector('.filter') as HTMLElement;
  const tab = (name: string) => within(filter().querySelector('.fpresets') as HTMLElement).getByRole('radio', { name: new RegExp(name) });
  const common = () => within(filter()).getByRole('radiogroup', { name: i18n.t('rarity.common') });

  test('it opens on the active preset, not the first one, and marks the active and the pending one', () => {
    mount({ inventory: bag([]), hunting: true, lootPresets: [ALPHA, BETA], activeLootId: BETA.id, pendingLootId: ALPHA.id });
    expect(tab('Beta')).toHaveAttribute('aria-checked', 'true');
    expect(tab('Alpha')).toHaveAttribute('aria-checked', 'false');
    expect(tab('Beta')).toHaveTextContent(en.bag.filter.tag.active);
    expect(tab('Alpha')).toHaveTextContent(en.bag.filter.tag.pending);
  });

  test('in town, the preset a start would use is the one marked', () => {
    mount({ inventory: bag([]), lootPresets: [ALPHA, BETA], activeLootId: ALPHA.id });
    expect(tab('Alpha')).toHaveAttribute('aria-checked', 'true');
    expect(tab('Alpha')).toHaveTextContent(en.bag.filter.tag.start);
  });

  test('an edited draft survives a newer version of its preset being read', () => {
    const view = mount({ inventory: bag([]), lootPresets: [ALPHA, BETA], activeLootId: ALPHA.id });
    fireEvent.click(within(common()).getByRole('radio', { name: en.loot.action.keep }));
    expect(within(filter()).getByText(en.bag.filter.edited)).toBeInTheDocument();
    view.rerenderPresets([{ ...ALPHA, presetVersion: ALPHA.presetVersion + 1 }, BETA]);
    expect(within(filter()).getByText(en.bag.filter.edited)).toBeInTheDocument();
    expect(within(common()).getByRole('radio', { name: en.loot.action.keep })).toHaveAttribute('aria-checked', 'true');
  });

  test('switching tabs keeps each tab’s draft', () => {
    mount({ inventory: bag([]), lootPresets: [ALPHA, BETA], activeLootId: ALPHA.id });
    fireEvent.click(within(common()).getByRole('radio', { name: en.loot.action.keep }));
    fireEvent.click(tab('Beta'));
    expect(within(filter()).queryByText(en.bag.filter.edited)).toBeNull();
    expect(within(common()).getByRole('radio', { name: en.loot.action['auto-sell'] })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(tab('Alpha'));
    expect(within(filter()).getByText(en.bag.filter.edited)).toBeInTheDocument();
    expect(within(common()).getByRole('radio', { name: en.loot.action.keep })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the bag shows only its own refusals (Minor 3)', () => {
  test('a refused lock is rendered from the server’s code under the item', async () => {
    const held = commands();
    held.lock = vi.fn(async () => {
      throw new CommandError('CONFLICT_STATE_VERSION', 'expectedStateVersion');
    });
    mount({ inventory: bag([item({ definitionId: 'wool-cloak' })]), commands: held });
    fireEvent.click(cells()[0]!);
    await act(async () => {
      fireEvent.click(within(tip()).getByRole('button', { name: en.bag.lock }));
    });
    expect(within(tip()).getByRole('alert')).toHaveTextContent(
      i18n.t('town.refused', { reason: i18n.t('serverError.CONFLICT_STATE_VERSION') }),
    );
  });

  test('a fault from elsewhere is not the bag’s to show', () => {
    mount({ inventory: bag([item({ definitionId: 'wool-cloak' })]) });
    fireEvent.click(cells()[0]!);
    expect(within(tip()).queryByRole('alert')).toBeNull();
  });
});

describe('the statusbar binds the one account state', () => {
  test('gold and bag occupancy come from the inventory read, and no premium timer exists', () => {
    const inventory: InventoryResponse = bag([item()], { gold: 4321 });
    mount({ inventory });
    const ledger = document.querySelector('.statusbar .ledger') as HTMLElement;
    expect(ledger).toHaveTextContent('4,321');
    expect(ledger).toHaveTextContent(`${inventory.usedSlots} / ${inventory.capacity}`);
    expect(document.querySelector('.ledger-premium')).toBeNull();
  });
});

export type { ItemInstance };
