/**
 * The Character screen's equipment pane (part 4 §3.4; `character.html`'s
 * `.gear-pane`): the eight slots around the silhouette, each the item the
 * server says this character wears or "Empty" with how many bag items fit,
 * and the selected slot's item tip with Unequip — a town-only command.
 *
 * Ruling R182: no sell price, roll range or comparison against a fixture is
 * shown; the tip carries the item's own figures only.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Content, ItemInstance, Slot } from '@narok/data';
import type { CharacterSummary } from '../commands';
import { classNames } from '../hud/model';
import { formatNumber } from '../i18n';
import { EMPTY_SLOT_ICON, itemIcon, rarityRow } from './icons';
import { useFigure } from './ItemCompare';
import { compareItems, equippedIn, fitsInBag } from './model';

const LEFT: readonly Slot[] = ['head', 'body', 'cloak', 'shoes'];
const RIGHT: readonly Slot[] = ['accessory1', 'accessory2', 'offhand', 'weapon'];

export interface GearPaneProps {
  readonly character: CharacterSummary;
  readonly items: readonly ItemInstance[];
  readonly content: Content;
  readonly hunting: boolean;
  readonly onUnequip: (slot: Slot) => Promise<void>;
}

export function GearPane({ character, items, content, hunting, onUnequip }: GearPaneProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const figure = useFigure();
  const [pinned, setPinned] = useState<Slot | null>(null);
  const [pending, setPending] = useState(false);
  const pinnedItem = pinned === null ? null : equippedIn(items, character.id, pinned);

  const slotRow = (slot: Slot) => {
    const worn = equippedIn(items, character.id, slot);
    const select = () => setPinned((current) => (current === slot || worn === null ? null : slot));
    if (worn === null) {
      const fits = fitsInBag(items, character, slot, content);
      return (
        <li className="gear gear--empty" key={slot}>
          <span className="gear-text">
            <span className="gear-slot">{t(`slot.${slot}`)}</span>
            <span className="gear-name">{t('character.empty')}</span>
            {fits > 0 && <span className="gear-hint">{t('character.fit', { count: fits })}</span>}
          </span>
          <span className="gslot">
            <svg aria-hidden="true">
              <use href={`#${EMPTY_SLOT_ICON[slot]}`} />
            </svg>
          </span>
        </li>
      );
    }
    return (
      <li
        className={classNames('gear', rarityRow(worn.rarity), pinned === slot && 'is-pinned')}
        key={slot}
        role="button"
        tabIndex={0}
        aria-pressed={pinned === slot}
        onClick={select}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select();
          }
        }}
      >
        <span className="gear-text">
          <span className="gear-slot">{t(`slot.${slot}`)}</span>
          <span className="gear-name">{t(`item.${worn.definitionId}`)}</span>
        </span>
        <span className="gslot">
          <svg aria-hidden="true">
            <use href={`#${itemIcon(worn, content)}`} />
          </svg>
          <span className="corner-text">{formatNumber(worn.itemLevel, i18n.language)}</span>
        </span>
      </li>
    );
  };

  return (
    <section className="pane gear-pane" aria-labelledby="gear-title">
      <h2 className="pane-title" id="gear-title">
        {t('character.gear')}
      </h2>
      <div className="doll">
        <ul className="gear-col gear-col--left">{LEFT.map(slotRow)}</ul>
        <figure className="figure" aria-hidden="true">
          <svg viewBox="0 0 104 250">
            <ellipse cx="52" cy="232" rx="46" ry="11" fill="none" stroke="#8d6b41" strokeWidth="1.5" />
            <path
              d="M52 22c-11 0-18 9-18 20 0 8 4 14 9 17h18c5-3 9-9 9-17 0-11-7-20-18-20Z"
              fill="#9cc0dc"
              fillOpacity=".16"
              stroke="#9cc0dc"
              strokeOpacity=".55"
              strokeWidth="1.4"
            />
            <path
              d="M40 62c-10 3-17 10-19 22l-7 60 12 4 6-40 2 118h36l2-118 6 40 12-4-7-60c-2-12-9-19-19-22Z"
              fill="#9cc0dc"
              fillOpacity=".12"
              stroke="#9cc0dc"
              strokeOpacity=".5"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </figure>
        <ul className="gear-col gear-col--right">{RIGHT.map(slotRow)}</ul>
      </div>

      {pinnedItem !== null && pinned !== null && (
        <article className="itip" aria-label={t(`item.${pinnedItem.definitionId}`)}>
          <div className="itip-head">
            <h3 className="itip-name">{t(`item.${pinnedItem.definitionId}`)}</h3>
            <span className="itip-pin">
              <svg aria-hidden="true">
                <use href="#i-pin" />
              </svg>
              {t('bag.pinned')}
            </span>
            <p className="itip-type">
              <b>{t(`rarity.${pinnedItem.rarity}`)}</b> {t(`slot.${pinned}`)}
            </p>
            <span className="itip-ilvl">{t('character.itemLevel', { level: formatNumber(pinnedItem.itemLevel, i18n.language) })}</span>
          </div>
          <dl className="itip-sec itip-base">
            {compareItems(pinnedItem, null, content).map((line) => (
              <div key={line.key}>
                <dt>{t(line.key)}</dt>
                <dd>{figure(line.after, line.unit, line.key.startsWith('bonus.'))}</dd>
              </div>
            ))}
          </dl>
          <div className="itip-foot">
            <button
              className="minibtn"
              type="button"
              disabled={hunting || pending}
              aria-busy={pending}
              onClick={() => {
                setPending(true);
                void onUnequip(pinned).finally(() => {
                  setPending(false);
                  setPinned(null);
                });
              }}
            >
              {hunting ? t('bag.block.hunting') : t('character.unequip')}
            </button>
            <button className="minibtn" type="button" onClick={() => setPinned(null)}>
              <svg aria-hidden="true">
                <use href="#i-close" />
              </svg>
              {t('bag.unpin')}
            </button>
          </div>
        </article>
      )}
    </section>
  );
}
