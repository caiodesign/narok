/**
 * The Bag and loot filter screen (milestone B Task 10; part 4 §3.3; UI spec §6).
 *
 * `codex-examples/realm-refined/bag.html` is the shape: the statusbar, the
 * bag window (tabs, search, sort, the slot grid, the pinned item tip, the
 * capacity footer) and the loot filter window, in the reference's own class
 * vocabulary. Its stylesheet is `bag.css`, mounted only while this screen is
 * (ruling R181). Every figure is the account's (ruling R182): the grid, the
 * counts and the ledger come from the one inventory read, and nothing the
 * server does not send is shown — no Materials tab, no bag expansion, no
 * premium timer, no price, no source line, no flavour text.
 *
 * Equip and lock are commands; the screen shows them pending and lets the
 * account read that follows bring the new state. Sale controls exist only
 * when the shop flag hands this screen a sale kit (ruling R185).
 *
 * Ruling R195: the screen shows only its own commands' refusals — the code of
 * the equip or lock it sent, caught from that command's rejection — never the
 * account's last error, which may be a Hunt start refused before the bag was
 * opened (Task 10 fix round 1, Minor 3).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Content, Slot } from '@narok/data';
import sheet from '../bag.css?raw';
import { faultOf, type CharacterSummary, type InventoryResponse, type LootPresetRecord, type PresetRef } from '../commands';
import { classNames } from '../hud/model';
import { formatNumber } from '../i18n';
import { FilterPane } from './FilterPane';
import { consumableIcon, itemIcon, rarityCell } from './icons';
import { blockText, ItemCompare, useFigure } from './ItemCompare';
import {
  BAG_CATEGORIES,
  BAG_SORTS,
  bagEntries,
  capacityOf,
  categoryCounts,
  definitionOf,
  eligibleCharacter,
  equipBlock,
  equippedIn,
  queryBag,
  shareOf,
  targetSlot,
  type BagCategory,
  type BagEntry,
  type BagSort,
} from './model';
import type { SaleKit } from './SaleControls';
import { useRouteSheet } from './sheets';
import { TownSprites } from './TownSprites';
import { SpriteSheet } from '../hud/SpriteSheet';
import { WorldBackdrop } from '../hud/WorldBackdrop';

/** Each rejects with the server's refusal; the screen renders the code (R195). */
export interface BagCommands {
  equip(itemId: string, characterId: string, slot: Slot): Promise<void>;
  lock(itemId: string, locked: boolean): Promise<void>;
  applyLoot(ref: PresetRef): Promise<void>;
  sell?(itemIds: readonly string[]): Promise<void>;
}

export interface BagScreenProps {
  readonly content: Content;
  readonly inventory: InventoryResponse | null;
  readonly characters: readonly CharacterSummary[];
  readonly lootPresets: readonly LootPresetRecord[];
  /** The loot preset the running hunt filters with, or a start would use (R190). */
  readonly activeLootId: string | null;
  /** A loot preset applied and waiting for earlier drops. */
  readonly pendingLootId: string | null;
  /** A hunt is running: equip waits for town; inspection, lock and the filter do not. */
  readonly hunting: boolean;
  readonly zone: string | null;
  readonly commands: BagCommands;
  /** The sale controls, present only with `VITE_FEATURE_SHOP` on (ruling R185). */
  readonly sale: SaleKit | null;
  readonly onBack: () => void;
}

export function BagScreen(props: BagScreenProps): React.JSX.Element {
  const { content, inventory, characters, lootPresets, activeLootId, pendingLootId, hunting, zone, commands, sale, onBack } = props;
  useRouteSheet('bag', sheet);
  const { t, i18n } = useTranslation();
  const figure = useFigure();
  const [category, setCategory] = useState<BagCategory>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<BagSort>(BAG_SORTS[0]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [pending, setPending] = useState<'equip' | 'lock' | null>(null);
  /** The code of this screen's last refused equip or lock (R195). */
  const [fault, setFault] = useState<string | null>(null);

  const entries = useMemo(() => bagEntries(inventory), [inventory]);
  const items = inventory?.items ?? [];
  const nameOf = (entry: BagEntry) =>
    entry.kind === 'item' ? t(`item.${entry.item.definitionId}`) : t(`consumable.${entry.consumableId}`);
  const shown = queryBag(entries, { category, search, sort }, nameOf);
  const counts = categoryCounts(entries);
  const capacity = capacityOf(inventory);
  const number = (value: number) => formatNumber(value, i18n.language);

  const tipKey = pinnedKey ?? selectedKey;
  const tipEntry = entries.find((entry) => entry.key === tipKey) ?? null;

  const cellLabel = (entry: BagEntry): string => {
    if (entry.kind === 'consumable') return t('bag.cell.consumable', { name: nameOf(entry), quantity: number(entry.quantity) });
    const parts = [nameOf(entry), t(`rarity.${entry.item.rarity}`)];
    if (entry.item.locked) parts.push(t('bag.cell.locked'));
    return parts.join(', ');
  };

  const run = (kind: 'equip' | 'lock', action: () => Promise<void>) => {
    if (pending !== null) return;
    setPending(kind);
    setFault(null);
    void action()
      .catch((error: unknown) => setFault(faultOf(error).code))
      .finally(() => setPending(null));
  };

  const cycleSort = () => setSort((current) => BAG_SORTS[(BAG_SORTS.indexOf(current) + 1) % BAG_SORTS.length]!);

  const emptyCells = capacity === null ? 0 : capacity.free;

  return (
    <div className="realm">
      <SpriteSheet />
      <TownSprites />
      <WorldBackdrop />
      <div className="dim" aria-hidden="true" />

      <header className="statusbar win">
        <button className="back" type="button" onClick={onBack}>
          <span className="back-seal" aria-hidden="true">
            <i />
          </span>
          <span className="back-text">
            <b>{zone === null ? t('town.name') : t(`map.${zone}`)}</b>
            <small>{hunting ? t('town.back.hunting') : t('town.back.inTown')}</small>
          </span>
        </button>
        <h1 className="screen-name">{t('bag.screen')}</h1>
        <div className="ledger">
          {inventory !== null && (
            <div className="ledger-item ledger-gold">
              <svg aria-hidden="true">
                <use href="#i-coin" />
              </svg>
              <div>
                {number(inventory.gold)}
                <small>{t('town.gold')}</small>
              </div>
            </div>
          )}
          {capacity !== null && (
            <div className="ledger-item ledger-bag">
              <svg aria-hidden="true">
                <use href="#i-bag" />
              </svg>
              <div>
                {t('bag.occupancy', { used: number(capacity.used), capacity: number(capacity.capacity) })}
                <small>{t('town.bag')}</small>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="desk">
        <section className="bag win" aria-labelledby="bag-title">
          <h2 className="win-title" id="bag-title">
            {t('bag.title')}{' '}
            {capacity !== null && (
              <span className="title-count">{t('bag.occupancy', { used: number(capacity.used), capacity: number(capacity.capacity) })}</span>
            )}{' '}
            <span className="title-meta">{t('bag.shared')}</span>
          </h2>

          <div className="bag-tools">
            <div className="tabs" role="tablist" aria-label={t('bag.categories')}>
              {BAG_CATEGORIES.map((entry) => (
                <button
                  key={entry}
                  className="tab"
                  role="tab"
                  type="button"
                  aria-selected={category === entry}
                  onClick={() => setCategory(entry)}
                >
                  {t(`bag.category.${entry}`)}
                  <span className="count num">{number(counts[entry])}</span>
                </button>
              ))}
            </div>
            <label className="field">
              <svg aria-hidden="true">
                <use href="#i-search" />
              </svg>
              <span className="sr-only">{t('bag.search')}</span>
              <input type="search" placeholder={t('bag.searchPlaceholder')} value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <button className="sort" type="button" onClick={cycleSort}>
              <svg aria-hidden="true">
                <use href="#i-sort" />
              </svg>
              <span className="sort-word">{t('bag.sort')}</span> <b>{t(`bag.sortBy.${sort}`)}</b>
              <svg aria-hidden="true">
                <use href="#i-caret" />
              </svg>
            </button>
          </div>

          <div className="bag-body">
            <div
              className="slots-scroll"
              tabIndex={0}
              aria-label={capacity === null ? t('bag.title') : t('bag.slots', { used: number(capacity.used), capacity: number(capacity.capacity) })}
            >
              <ol className="bag-grid">
                {shown.map((entry) => (
                  <li className="cell" key={entry.key}>
                    <button
                      className={classNames('item', entry.kind === 'item' ? rarityCell(entry.item.rarity) : 'r-plain', selectedKey === entry.key && 'is-selected')}
                      type="button"
                      aria-label={cellLabel(entry)}
                      aria-pressed={selectedKey === entry.key}
                      aria-controls="itemtip"
                      onClick={() => setSelectedKey(entry.key)}
                    >
                      <svg aria-hidden="true">
                        <use href={`#${entry.kind === 'item' ? itemIcon(entry.item, content) : consumableIcon(entry.consumableId, content)}`} />
                      </svg>
                      {entry.kind === 'item' && entry.item.locked && (
                        <span className="lock-mark" aria-hidden="true">
                          <svg>
                            <use href="#i-lock" />
                          </svg>
                        </span>
                      )}
                      {entry.kind === 'consumable' && (
                        <span className="qty" aria-hidden="true">
                          {number(entry.quantity)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
                {category === 'all' && search.trim() === '' &&
                  Array.from({ length: emptyCells }, (_, index) => <li className="cell cell--empty" aria-hidden="true" key={`empty-${index}`} />)}
              </ol>
            </div>

            <aside className="itemtip" id="itemtip" aria-labelledby="tip-name" aria-live="polite">
              {tipEntry === null ? (
                <p className="tip-kind">{t('bag.noSelection')}</p>
              ) : (
                renderTip(tipEntry, pinnedKey !== null, () => setPinnedKey(tipEntry.key), () => setPinnedKey(null))
              )}
            </aside>
          </div>

          <footer className="bag-foot">
            {capacity !== null && (
              <div className="capacity">
                <svg aria-hidden="true">
                  <use href="#i-bag" />
                </svg>
                <p className="capacity-line">
                  {t('bag.capacityLine', { used: number(capacity.used), capacity: number(capacity.capacity), free: number(capacity.free) })}
                </p>
                <div
                  className="capacity-meter"
                  role="meter"
                  aria-label={t('bag.capacityMeter')}
                  aria-valuenow={capacity.used}
                  aria-valuemin={0}
                  aria-valuemax={capacity.capacity}
                >
                  <i style={{ width: `calc(${shareOf(capacity.used, capacity.capacity)}% - 2px)` }} />
                </div>
              </div>
            )}
            {sale !== null && commands.sell !== undefined && <sale.Bulk items={items} onSell={commands.sell} />}
          </footer>
        </section>

        <FilterPane
          content={content}
          presets={lootPresets}
          items={items.filter((entry) => entry.equipped === null)}
          hunting={hunting}
          activeId={activeLootId}
          pendingId={pendingLootId}
          onApply={commands.applyLoot}
        />
      </main>
    </div>
  );

  function renderTip(entry: BagEntry, pinned: boolean, onPin: () => void, onUnpin: () => void): React.JSX.Element {
    const bar = (
      <p className="tip-bar">
        <svg aria-hidden="true">
          <use href="#i-pin" />
        </svg>
        {pinned ? t('bag.pinned') : t('bag.selected')}
        {pinned ? (
          <button className="tip-close" type="button" aria-label={t('bag.unpin')} onClick={onUnpin}>
            <svg aria-hidden="true">
              <use href="#i-close" />
            </svg>
          </button>
        ) : (
          <button className="tip-close" type="button" aria-label={t('bag.pin')} onClick={onPin}>
            <svg aria-hidden="true">
              <use href="#i-pin" />
            </svg>
          </button>
        )}
      </p>
    );

    if (entry.kind === 'consumable') {
      return (
        <>
          {bar}
          <div className="tip-head">
            <span className="tip-icon">
              <svg aria-hidden="true">
                <use href={`#${consumableIcon(entry.consumableId, content)}`} />
              </svg>
            </span>
            <div>
              <h3 className="tip-name" id="tip-name">
                {nameOf(entry)}
              </h3>
              <p className="tip-kind">{t('bag.consumableKind')}</p>
            </div>
          </div>
          <dl className="tip-facts">
            <div>
              <dt>{t('bag.quantity')}</dt>
              <dd>{number(entry.quantity)}</dd>
            </div>
            <div>
              <dt>{t('bag.stacks')}</dt>
              <dd>{number(entry.stacks)}</dd>
            </div>
          </dl>
        </>
      );
    }

    const { item } = entry;
    const definition = definitionOf(item, content);
    const chosen = characters.find((character) => character.id === compareId) ?? eligibleCharacter(item, characters, content);
    const slot = definition === undefined || chosen === null ? null : targetSlot(definition, items, chosen.id);
    const current = chosen === null || slot === null ? null : equippedIn(items, chosen.id, slot);
    const block = chosen === null ? null : equipBlock(item, chosen, hunting, content);
    const equipLabel =
      chosen === null
        ? t('bag.cannotEquip')
        : block === null
          ? t('bag.equipOn', { name: chosen.name })
          : block.reason === 'hunting'
            ? t('bag.block.hunting')
            : block.reason === 'level'
              ? t('bag.requires', { level: block.required })
              : t('bag.cannotEquip');

    return (
      <>
        {bar}
        <div className="tip-head">
          <span className="tip-icon">
            <svg aria-hidden="true">
              <use href={`#${itemIcon(item, content)}`} />
            </svg>
          </span>
          <div>
            <h3 className="tip-name" id="tip-name">
              {nameOf(entry)}
            </h3>
            <p className="tip-kind">
              {t('bag.kind', { rarity: t(`rarity.${item.rarity}`), slot: definition === undefined ? '' : t(`slot.${definition.slot}`) })}
            </p>
          </div>
        </div>
        <dl className="tip-facts">
          <div>
            <dt>{t('bag.itemLevel')}</dt>
            <dd>{number(item.itemLevel)}</dd>
          </div>
          {definition !== undefined && (
            <div>
              <dt>{t('bag.requiresLabel')}</dt>
              <dd>{t('bag.levelShort', { level: definition.levelRequirement })}</dd>
            </div>
          )}
          <div>
            <dt>{t('bag.bonuses')}</dt>
            <dd>{number(item.bonuses.length)}</dd>
          </div>
        </dl>
        {item.bonuses.length > 0 && (
          <ul className="tip-bonuses">
            {item.bonuses.map((bonus) => (
              <li key={bonus.bonusId}>
                <b>{figure(bonus.value, content.bonuses[bonus.bonusId]?.unit ?? 'flat')}</b>
                {t(`bonus.${bonus.bonusId}`)}
              </li>
            ))}
          </ul>
        )}
        {item.boundTo !== null && <p className="tip-source">{t('bag.boundTo', { name: characters.find((c) => c.id === item.boundTo)?.name ?? '' })}</p>}
        {chosen !== null && slot !== null && (
          <ItemCompare
            item={item}
            current={current}
            slot={slot}
            character={chosen}
            characters={characters}
            block={block}
            content={content}
            onCompareWith={setCompareId}
          />
        )}
        <div className="tip-actions">
          <button
            className="act act--equip"
            type="button"
            disabled={block !== null || chosen === null || slot === null || pending !== null}
            aria-busy={pending === 'equip'}
            title={block === null || chosen === null ? undefined : blockText(t, block, chosen.name)}
            onClick={() => {
              if (chosen === null || slot === null || block !== null) return;
              run('equip', () => commands.equip(item.id, chosen.id, slot));
            }}
          >
            {equipLabel}
          </button>
          <button
            className="act"
            type="button"
            aria-pressed={item.locked}
            disabled={pending !== null}
            aria-busy={pending === 'lock'}
            onClick={() => run('lock', () => commands.lock(item.id, !item.locked))}
          >
            <svg aria-hidden="true">
              <use href="#i-lock" />
            </svg>
            {item.locked ? t('bag.unlock') : t('bag.lock')}
          </button>
          {sale !== null && commands.sell !== undefined && <sale.Tip item={item} onSell={commands.sell} />}
        </div>
        {fault !== null && (
          <p className="eligibility" role="alert">
            {t('town.refused', { reason: t(`serverError.${fault}`) })}
          </p>
        )}
      </>
    );
  }
}
