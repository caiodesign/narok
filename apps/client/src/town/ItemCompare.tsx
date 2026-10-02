/**
 * The item tip's comparison (part 4 §3.3 "Comparison"; B-12): the selected
 * item against what a real character wears in the real slot it would go
 * into, figure by figure with signed deltas, the restriction that applies, and
 * the empty-slot case said in words.
 *
 * Ruling R187: the compared figures are the item's own — its definition's
 * base values and its rolled bonuses. Derived combat stats are the engine's
 * formula, which the client does not run (B-02), so no "after" combat stat is
 * projected; a bonus count is never presented as an upgrade recommendation.
 */
import { useTranslation } from 'react-i18next';
import type { Content, ItemInstance, Slot } from '@narok/data';
import type { CharacterSummary } from '../commands';
import { formatNumber } from '../i18n';
import { classNames } from '../hud/model';
import { compareItems, percentOf, secondsOf, type EquipBlock, type StatLine } from './model';

export interface ItemCompareProps {
  readonly item: ItemInstance;
  readonly current: ItemInstance | null;
  readonly slot: Slot;
  readonly character: CharacterSummary;
  readonly characters: readonly CharacterSummary[];
  readonly block: EquipBlock | null;
  readonly content: Content;
  readonly onCompareWith: (characterId: string) => void;
}

/** A figure in its unit, signed when it is a change. */
export function useFigure(): (value: number | null, unit: StatLine['unit'], signed?: boolean) => string {
  const { t, i18n } = useTranslation();
  return (value, unit, signed = true) => {
    if (value === null) return t('value.none');
    const sign = signed && value > 0 ? '+' : value < 0 ? '−' : '';
    const magnitude = Math.abs(value);
    if (unit === 'bp') return `${sign}${t('bag.percent', { value: formatNumber(percentOf(magnitude), i18n.language, 2) })}`;
    if (unit === 'ms') return `${sign}${t('duration.seconds', { value: formatNumber(secondsOf(magnitude), i18n.language, 2) })}`;
    return `${sign}${formatNumber(magnitude, i18n.language)}`;
  };
}

/** A longer attack interval is slower: its sign is read the other way round. */
const better = (line: StatLine): number => (line.unit === 'ms' ? -line.delta : line.delta);

/** Why an item cannot be equipped, in words (both levels for an under-level item). */
export function blockText(t: (key: string, options?: Record<string, unknown>) => string, block: EquipBlock, name: string): string {
  switch (block.reason) {
    case 'class':
      return t('bag.block.class', { classes: block.classes.map((id) => t(`class.${id}`)).join(', ') });
    case 'level':
      return t('bag.block.level', { required: block.required, name, current: block.current });
    case 'bound':
      return t('bag.block.bound');
    case 'unknown':
      return t('bag.block.unknown');
    case 'hunting':
      return t('bag.block.hunting');
  }
}

export function ItemCompare({ item, current, slot, character, characters, block, content, onCompareWith }: ItemCompareProps): React.JSX.Element {
  const { t } = useTranslation();
  const figure = useFigure();
  const lines = compareItems(item, current, content);
  const itemName = t(`item.${item.definitionId}`);

  return (
    <>
      <p className="tip-compare">
        <label>
          <span className="sr-only">{t('bag.compareWith')}</span>
          <select aria-label={t('bag.compareWith')} value={character.id} onChange={(event) => onCompareWith(event.target.value)}>
            {characters.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <span>
          {current === null
            ? t('bag.emptySlot', { name: character.name, slot: t(`slot.${slot}`) })
            : t('bag.comparedWith', { name: character.name, item: t(`item.${current.definitionId}`) })}
        </span>
      </p>
      <table className="comparison" aria-label={t('bag.comparison', { item: itemName })}>
        <thead>
          <tr>
            <th>{t('bag.stat')}</th>
            <th>{t('bag.equipped')}</th>
            <th>{t('bag.thisItem')}</th>
            <th>{t('bag.change')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key}>
              <th>{t(line.key)}</th>
              <td>{figure(line.before, line.unit)}</td>
              <td>{figure(line.after, line.unit)}</td>
              <td className={classNames(better(line) > 0 && 'gain', better(line) < 0 && 'loss')}>
                {line.delta === 0 ? t('value.none') : figure(line.delta, line.unit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {block !== null && block.reason !== 'hunting' && <p className="eligibility">{blockText(t, block, character.name)}</p>}
    </>
  );
}
