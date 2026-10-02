/**
 * The loot filter pane (part 4 §3.3; UI spec §6; B-14's client half).
 *
 * Ruling R188: the rarity rules are a local draft and Apply sends only a
 * saved version — because B has no loot-preset save route, and applying a
 * draft would apply something no version names. In detail: the draft is
 * marked edited and kept until reverted; the preview runs `@narok/loot`'s `evaluate` — the server's
 * and the simulation's own — over the equipment the bag holds, the only drop
 * records the client reads, and changes none of them. Apply sends the
 * *saved* preset version to the running hunt and governs future drops only;
 * B has no loot-preset save route, so a dirty draft cannot be applied and the
 * pane says so rather than applying something the server never stored.
 *
 * Ruling R190: the pane opens on the active preset — the one the running hunt
 * filters with, or in town the one a start would use — and marks it, and marks
 * a preset applied but still waiting for earlier drops as pending; because
 * part 4 §3.3 reads "the active and draft loot presets", and the first preset
 * in the list is only an alphabetical accident.
 *
 * Ruling R196: drafts are kept per preset, so switching tabs never discards
 * one, and a newly read version of a preset leaves an edited draft in place —
 * still marked edited against the version now saved — because part 4 §3.3
 * requires the draft "preserved across recoverable failures" and a refresh is
 * not the player's decision to drop it. Revert is the only way a draft goes.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Content, ItemInstance, Rarity } from '@narok/data';
import { LOOT_ACTIONS, LOOT_RARITIES, type LootAction, type LootCondition, type LootPreset } from '@narok/loot';
import { faultOf, type LootPresetRecord, type PresetRef } from '../commands';
import { classNames } from '../hud/model';
import { dropOf, previewFilter, tally } from './model';

export interface FilterPaneProps {
  readonly content: Content;
  readonly presets: readonly LootPresetRecord[];
  /** The bag's unequipped equipment: what the preview evaluates. */
  readonly items: readonly ItemInstance[];
  /** A hunt is running, so a filter can be applied to its future drops. */
  readonly hunting: boolean;
  /** The running hunt's active preset, or in town the one a start would use (R190). */
  readonly activeId: string | null;
  /** A preset applied to the running hunt and still waiting for earlier drops. */
  readonly pendingId: string | null;
  readonly onApply: (ref: PresetRef) => Promise<void>;
}

const PROTECTED: Rarity = LOOT_RARITIES[LOOT_RARITIES.length - 1]!;

function sameRules(a: LootPreset['rarity'], b: LootPreset['rarity']): boolean {
  return LOOT_RARITIES.every((rarity) => a[rarity] === b[rarity]);
}

function conditionText(t: (key: string, options?: Record<string, unknown>) => string, when: LootCondition): string {
  const parts: string[] = [];
  if (when.category !== undefined) parts.push(t(`loot.category.${when.category}`));
  if (when.slot !== undefined) parts.push(t(`slot.${when.slot}`));
  if (when.minRarity !== undefined) parts.push(t('loot.condition.minRarity', { rarity: t(`rarity.${when.minRarity}`) }));
  if (when.minBonusCount !== undefined) parts.push(t('loot.condition.minBonusCount', { count: when.minBonusCount }));
  if (when.bonusId !== undefined) parts.push(t('loot.condition.bonus', { bonus: t(`bonus.${when.bonusId}`) }));
  if (when.minItemLevel !== undefined) parts.push(t('loot.condition.minItemLevel', { level: when.minItemLevel }));
  return parts.join(t('loot.condition.and'));
}

const verdictClass = (action: LootAction): string =>
  action === 'keep' ? 'verdict--keep' : action === 'auto-sell' ? 'verdict--sell' : 'verdict--ignore';

export function FilterPane({ content, presets, items, hunting, activeId, pendingId, onApply }: FilterPaneProps): React.JSX.Element {
  const { t } = useTranslation();
  // The player's own tab choice; until there is one, the active preset (R190).
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selected = presets.find((preset) => preset.id === (pickedId ?? activeId)) ?? presets[0] ?? null;
  const saved = selected?.payload ?? null;
  // One draft per preset id, never cleared by a refresh (R196).
  const [drafts, setDrafts] = useState<Readonly<Record<string, LootPreset['rarity']>>>({});
  const draftRarity = selected === null ? null : (drafts[selected.id] ?? null);
  const [applying, setApplying] = useState(false);
  /** The code of this pane's last refused Apply (R195). */
  const [refusal, setRefusal] = useState<string | null>(null);

  const setDraft = (rarity: LootPreset['rarity'] | null) => {
    if (selected === null) return;
    const id = selected.id;
    setDrafts((current) => {
      const next = { ...current };
      if (rarity === null) delete next[id];
      else next[id] = rarity;
      return next;
    });
  };

  const draft: LootPreset | null = saved === null ? null : { ...saved, rarity: draftRarity ?? saved.rarity };
  const dirty = saved !== null && draftRarity !== null && !sameRules(draftRarity, saved.rarity);

  const records = useMemo(
    () => items.map((entry) => ({ key: entry.id, item: entry, drop: dropOf(entry, content) })),
    [items, content],
  );
  const rows = draft === null ? [] : previewFilter(records, draft, saved);
  const counts = tally(rows);

  const choose = (rarity: Rarity, action: LootAction) => {
    if (saved === null) return;
    setDraft({ ...(draftRarity ?? saved.rarity), [rarity]: action });
  };

  const apply = () => {
    if (selected === null || dirty || !hunting || applying) return;
    setApplying(true);
    setRefusal(null);
    void onApply({ presetId: selected.id, presetVersion: selected.presetVersion })
      .catch((error: unknown) => setRefusal(faultOf(error).code))
      .finally(() => setApplying(false));
  };

  const recordFor = (key: string) => records.find((record) => record.key === key)!;

  return (
    <section className="filter win" aria-labelledby="filter-title">
      <h2 className="win-title" id="filter-title">
        {t('bag.filter.title')} {dirty && <span className="edited">{t('bag.filter.edited')}</span>}{' '}
        <span className="title-meta">{t('bag.filter.saved', { count: presets.length })}</span>
      </h2>

      <div className="filter-body">
        <div className="fpresets" role="radiogroup" aria-label={t('bag.filter.presets')}>
          {presets.map((preset) => (
            <button
              key={preset.id}
              className="fpreset"
              type="button"
              role="radio"
              aria-checked={preset.id === selected?.id}
              onClick={() => setPickedId(preset.id)}
            >
              {preset.name}
              {preset.id === activeId && <small> {t(hunting ? 'bag.filter.tag.active' : 'bag.filter.tag.start')}</small>}
              {preset.id === pendingId && <small> {t('bag.filter.tag.pending')}</small>}
              {drafts[preset.id] !== undefined && preset.payload !== undefined && !sameRules(drafts[preset.id]!, preset.payload.rarity) && (
                <span className="dirty" title={t('bag.filter.unsaved')} />
              )}
            </button>
          ))}
        </div>

        {draft !== null && (
          <section className="fsec" aria-labelledby="ramp-title">
            <h3 className="older" id="ramp-title">
              {t('bag.filter.byRarity')}
            </h3>
            <ol className="ramp">
              {LOOT_RARITIES.map((rarity) => {
                const current = draft.rarity[rarity] ?? draft.fallback.equipment;
                return (
                  <li key={rarity} className={`tier t-${rarity}`}>
                    <span className="tier-name">{t(`rarity.${rarity}`)}</span>
                    <span className="tier-note">{t('bag.filter.bonuses', { count: content.rarities[rarity].bonusCount })}</span>
                    {rarity === PROTECTED ? (
                      <div className="choice">
                        <p className="locked">
                          <svg aria-hidden="true">
                            <use href="#i-lock" />
                          </svg>
                          {t('bag.filter.alwaysKept')}
                        </p>
                      </div>
                    ) : (
                      <div className="choice" role="radiogroup" aria-label={t(`rarity.${rarity}`)}>
                        {LOOT_ACTIONS.map((action) => (
                          <button
                            key={action}
                            className={classNames(current === action && action === 'keep' && 'on-keep', current === action && action === 'auto-sell' && 'on-sell')}
                            type="button"
                            role="radio"
                            aria-checked={current === action}
                            onClick={() => choose(rarity, action)}
                          >
                            {t(`loot.action.${action}`)}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            <p className="fhint">{t('bag.filter.precedence')}</p>
          </section>
        )}

        {draft !== null && draft.exceptions.length > 0 && (
          <section className="fsec" aria-labelledby="rules-title">
            <div className="sec-head">
              <h3 className="older" id="rules-title">
                {t('bag.filter.exceptions')} <small>{t('bag.filter.firstMatch')}</small>
              </h3>
            </div>
            <ol className="rules">
              {draft.exceptions.map((exception, index) => (
                <li className="rule" key={index}>
                  <span className="rule-no">{index + 1}</span>
                  <p className="rule-if">{conditionText(t, exception.when)}</p>
                  <span className={`verdict ${verdictClass(exception.action)}`}>{t(`loot.action.${exception.action}`)}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {draft !== null && (
          <section className="fsec" aria-labelledby="preview-title">
            <h3 className="older" id="preview-title">
              {t('bag.filter.preview')} <small>{t('bag.filter.previewOver', { count: rows.length })}</small>
            </h3>
            <ul className="loot-list preview">
              {rows.map((row) => {
                const { item } = recordFor(row.key);
                const matched =
                  row.disposition.matched === 'protected'
                    ? t('bag.filter.matched.protected')
                    : row.disposition.matched === 'default'
                      ? t('bag.filter.matched.default')
                      : t('bag.filter.matched.exception', { number: row.disposition.matched.exception + 1 });
                return (
                  <li
                    key={row.key}
                    className={classNames(
                      'drop',
                      `drop--${item.rarity}`,
                      row.disposition.action === 'keep' ? 'drop--kept' : 'drop--sold',
                      row.changed && 'drop--changed',
                    )}
                  >
                    <span className="drop-name">{t(`item.${item.definitionId}`)}</span>
                    <span className="why">{t(`loot.action.${row.disposition.action}`)}</span>
                    <span className="drop-note">
                      {t('bag.filter.rowNote', { rarity: t(`rarity.${item.rarity}`), level: item.itemLevel, matched })}
                      {row.changed && row.saved !== null && ` ${t('bag.filter.savedWould', { action: t(`loot.action.${row.saved.action}`) })}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      <footer className="filter-foot">
        <p className="tally">
          <span className="tally-now">{t('bag.filter.tally', { keep: counts.keep, sold: counts['auto-sell'], ignored: counts.ignore })}</span>
          {refusal !== null ? (
            <span className="was" role="alert">
              {t('town.refused', { reason: t(`serverError.${refusal}`) })}
            </span>
          ) : (
            <span className="was">{dirty ? t('bag.filter.cannotApplyDraft') : t('bag.filter.previewOnly')}</span>
          )}
        </p>
        <button className="btn-revert" type="button" disabled={!dirty} onClick={() => setDraft(null)}>
          {t('bag.filter.revert')}
        </button>
        <button
          className="btn-save"
          type="button"
          disabled={selected === null || dirty || !hunting || applying}
          aria-busy={applying}
          title={hunting ? undefined : t('bag.filter.noHunt')}
          onClick={apply}
        >
          {t('bag.filter.apply')}
        </button>
      </footer>
    </section>
  );
}
