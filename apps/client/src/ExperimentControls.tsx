/**
 * Setup and run controls (ruling R55). Edits a draft `LabInput` separately from
 * whatever experiment is currently running — changing the draft never mutates a
 * running experiment; pressing "Start experiment" hands the draft to `onStart`,
 * which the hook turns into a new generation.
 *
 * Every visible string comes from `t()` (ruling R60); the run buttons carry the
 * accessible names ruling R81 fixes for the Task 11 smoke test.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Content, ClassId, RecipeId } from '@narok/data';
import type { ActorId, LabInput, PositionId, Strategy, TargetMode } from '@narok/sim';
import { defaultPlacement, defaultStrategy, gridPosition } from '@narok/sim';
import { formatNumber, type Translate } from './i18n';
import type { ExperimentStatus } from './useExperiment';
import { validateLabInput, type ValidationIssue } from './validation';

const CLASS_IDS: ClassId[] = ['guardian', 'cleric', 'ranger', 'arcanist'];
const SPEEDS = [1, 4, 16] as const;
const PRIORITY_TARGET_KINDS = ['lowest-hp', 'highest-hp', 'highest-level', 'nearest'] as const;

function cellId(column: number, row: number): PositionId {
  return gridPosition(column, row);
}

/** Every party cell in row-major order; the last-resort source of a free seat. */
function partyCells(grid: Content['grid']): PositionId[] {
  const cells: PositionId[] = [];
  for (const row of [...grid.playerRows].sort((a, b) => a - b)) {
    for (let column = 0; column < grid.width; column++) cells.push(cellId(column, row));
  }
  return cells;
}

/**
 * Seats every roster member (Task 11 fix). Cells the user chose are kept as they
 * are; anyone still unseated takes spec §8's default seat — `defaultPlacement`,
 * the same rule the CLI's `default` placement uses — or, if a retained placement
 * already holds that cell, the first free party cell.
 *
 * Before this existed the draft opened with `placement: {}`, so a cold page load
 * raised "Every roster member needs a placement" and disabled "Start experiment"
 * before the user had touched anything; the Playwright smoke could not start a
 * run at all. Growing the roster left the new member unseated for the same
 * reason.
 */
function seatRoster(
  classes: ClassId[],
  grid: Content['grid'],
  existing: Record<ActorId, PositionId> = {},
): Record<ActorId, PositionId> {
  const ids = classes.map((_classId, index) => `p${index}`);
  const preferred = defaultPlacement(classes);
  const taken = new Set<PositionId>();
  const placement: Record<ActorId, PositionId> = {};
  for (const id of ids) {
    const kept = existing[id];
    if (kept !== undefined && !taken.has(kept)) {
      placement[id] = kept;
      taken.add(kept);
    }
  }
  for (const id of ids) {
    if (placement[id] !== undefined) continue;
    const seat =
      preferred[id] !== undefined && !taken.has(preferred[id])
        ? preferred[id]
        : partyCells(grid).find((cell) => !taken.has(cell));
    // A 5x5 board has ten party cells against a roster of at most three, so this
    // cannot run out; if a future grid did, validation reports the gap.
    if (seat === undefined) continue;
    placement[id] = seat;
    taken.add(seat);
  }
  return placement;
}

function defaultDraft(grid: Content['grid']): LabInput {
  const classes: ClassId[] = ['guardian', 'cleric', 'ranger'];
  const strategies: Record<ActorId, Strategy> = {};
  classes.forEach((classId, index) => {
    strategies[`p${index}`] = defaultStrategy(classId);
  });
  return {
    seed: 1,
    classes,
    recipe: 'mixed',
    placement: seatRoster(classes, grid),
    strategies,
    rest: { hpStart: 50, mpStart: 30 },
    wipeLimit: 1,
  };
}

function issuesFor(field: string, issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((issue) => issue.field === field || issue.field.startsWith(`${field}.`));
}

export interface ExperimentControlsProps {
  content: Content;
  status: ExperimentStatus;
  onStart: (input: LabInput) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSpeedChange: (speed: number) => void;
}

export function ExperimentControls({
  content,
  status,
  onStart,
  onPause,
  onResume,
  onStop,
  onSpeedChange,
}: ExperimentControlsProps): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;

  const [draft, setDraft] = useState<LabInput>(() => defaultDraft(content.grid));
  const [selectedActorId, setSelectedActorId] = useState<ActorId | null>(null);
  // Ruling R77: default focus must land on a real, reachable party cell -- (0,0)
  // is an enemy-row cell whenever row 0 isn't a party row, and a disabled cell
  // with the roving tabindex's only tabIndex={0} makes the whole grid
  // unreachable by Tab.
  const [focusedCell, setFocusedCell] = useState<{ column: number; row: number }>(() => ({
    column: 0,
    row: [...content.grid.playerRows].sort((a, b) => a - b)[0] ?? 0,
  }));
  const [speed, setLocalSpeed] = useState<number>(1);
  const cellRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const rosterIds = useMemo<ActorId[]>(() => draft.classes.map((_, index) => `p${index}`), [draft.classes]);
  const issues = useMemo(() => validateLabInput(draft, content), [draft, content]);

  useEffect(() => {
    const key = cellId(focusedCell.column, focusedCell.row);
    cellRefs.current[key]?.focus();
  }, [focusedCell]);

  const setRosterSize = useCallback(
    (size: number) => {
      setDraft((previous) => {
        const classes = [...previous.classes];
        while (classes.length < size) classes.push('guardian');
        classes.length = size;
        const ids = classes.map((_, index) => `p${index}`);
        const strategies: Record<ActorId, Strategy> = {};
        ids.forEach((id, index) => {
          strategies[id] = previous.strategies[id] ?? defaultStrategy(classes[index]);
        });
        // Seats the grown roster instead of leaving the new member unplaced:
        // cells the user already chose are kept, and anyone still unseated takes
        // a free default seat, so the start control never disables itself over a
        // placement the user was never asked for.
        const placement = seatRoster(classes, content.grid, previous.placement);
        return { ...previous, classes, strategies, placement };
      });
      setSelectedActorId(null);
    },
    [content.grid],
  );

  const setActorClass = useCallback((actorId: ActorId, classId: ClassId) => {
    setDraft((previous) => {
      const index = Number(actorId.slice(1));
      const classes = [...previous.classes];
      classes[index] = classId;
      return {
        ...previous,
        classes,
        strategies: { ...previous.strategies, [actorId]: defaultStrategy(classId) },
      };
    });
  }, []);

  const placeSelectedAt = useCallback(
    (column: number, row: number) => {
      if (!selectedActorId) return;
      if (!content.grid.playerRows.includes(row)) return;
      setDraft((previous) => ({
        ...previous,
        placement: { ...previous.placement, [selectedActorId]: cellId(column, row) },
      }));
    },
    [content.grid.playerRows, selectedActorId],
  );

  const moveFocus = useCallback(
    // Ruling R77: row movement is clamped to party rows, never landing focus on
    // a disabled (non-party) cell -- vertical arrow presses step between party
    // rows only; column movement stays within the grid width on the same row.
    (deltaColumn: number, deltaRow: number) => {
      setFocusedCell((previous) => {
        if (deltaRow !== 0) {
          const partyRows = [...content.grid.playerRows].sort((a, b) => a - b);
          const currentIndex = partyRows.indexOf(previous.row);
          const fromIndex = currentIndex === -1 ? (deltaRow > 0 ? -1 : partyRows.length) : currentIndex;
          const nextIndex = Math.min(partyRows.length - 1, Math.max(0, fromIndex + deltaRow));
          return { column: previous.column, row: partyRows[nextIndex] ?? previous.row };
        }
        return {
          row: previous.row,
          column: Math.min(content.grid.width - 1, Math.max(0, previous.column + deltaColumn)),
        };
      });
    },
    [content.grid.playerRows, content.grid.width],
  );

  const onCellKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, column: number, row: number) => {
      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault();
          moveFocus(0, -1);
          return;
        case 'ArrowDown':
          event.preventDefault();
          moveFocus(0, 1);
          return;
        case 'ArrowLeft':
          event.preventDefault();
          moveFocus(-1, 0);
          return;
        case 'ArrowRight':
          event.preventDefault();
          moveFocus(1, 0);
          return;
        case 'Enter':
        case ' ':
          event.preventDefault();
          placeSelectedAt(column, row);
          return;
        default:
          return;
      }
    },
    [moveFocus, placeSelectedAt],
  );

  const setRuleEnabled = useCallback((actorId: ActorId, ruleIndex: number, enabled: boolean) => {
    setDraft((previous) => {
      const strategy = previous.strategies[actorId];
      if (!strategy) return previous;
      const rules = strategy.rules.map((rule, index) => (index === ruleIndex ? { ...rule, enabled } : rule));
      return { ...previous, strategies: { ...previous.strategies, [actorId]: { ...strategy, rules } } };
    });
  }, []);

  const setRuleThreshold = useCallback((actorId: ActorId, ruleIndex: number, value: number) => {
    setDraft((previous) => {
      const strategy = previous.strategies[actorId];
      if (!strategy) return previous;
      const rules = strategy.rules.map((rule, index) => {
        if (index !== ruleIndex || !('value' in rule.condition)) return rule;
        return { ...rule, condition: { ...rule.condition, value } };
      });
      return { ...previous, strategies: { ...previous.strategies, [actorId]: { ...strategy, rules } } };
    });
  }, []);

  /** Order IS priority (R28 scans rules in order): move-up/move-down reorders the rules array. */
  const moveRule = useCallback((actorId: ActorId, ruleIndex: number, direction: -1 | 1) => {
    setDraft((previous) => {
      const strategy = previous.strategies[actorId];
      if (!strategy) return previous;
      const target = ruleIndex + direction;
      if (target < 0 || target >= strategy.rules.length) return previous;
      const rules = [...strategy.rules];
      const [moved] = rules.splice(ruleIndex, 1);
      rules.splice(target, 0, moved);
      return { ...previous, strategies: { ...previous.strategies, [actorId]: { ...strategy, rules } } };
    });
  }, []);

  const setTargetKind = useCallback(
    (actorId: ActorId, kind: TargetMode['kind']) => {
      setDraft((previous) => {
        const strategy = previous.strategies[actorId];
        if (!strategy) return previous;
        const ids = previous.classes.map((_, index) => `p${index}`);
        const target: TargetMode =
          kind === 'attacking'
            ? { kind: 'attacking', partyId: ids.find((id) => id !== actorId) ?? actorId }
            : { kind };
        return { ...previous, strategies: { ...previous.strategies, [actorId]: { ...strategy, target } } };
      });
    },
    [],
  );

  const setTargetPartyId = useCallback((actorId: ActorId, partyId: ActorId) => {
    setDraft((previous) => {
      const strategy = previous.strategies[actorId];
      if (!strategy || strategy.target.kind !== 'attacking') return previous;
      return {
        ...previous,
        strategies: { ...previous.strategies, [actorId]: { ...strategy, target: { kind: 'attacking', partyId } } },
      };
    });
  }, []);

  const selectedLabel = selectedActorId
    ? t('controls.selected', {
        class: t(`class.${draft.classes[Number(selectedActorId.slice(1))]}`),
        actor: selectedActorId,
      })
    : t('controls.selectedNone');

  const placementIssues = issuesFor('placement', issues);
  const canStart = issues.length === 0;

  return (
    <section className="win panel controls-panel" aria-label={t('controls.section')}>
      <h2 className="win-title">{t('app.setup')}</h2>

      <fieldset>
        <legend>{t('controls.roster')}</legend>
        <div className="row" role="group" aria-label={t('controls.rosterSize')}>
          {[1, 2, 3].map((size) => (
            <label key={size} className="chip">
              <input
                type="radio"
                name="roster-size"
                value={size}
                checked={draft.classes.length === size}
                onChange={() => setRosterSize(size)}
              />
              {formatNumber(size, language)}
            </label>
          ))}
        </div>
        {issuesFor('classes', issues).map((issue, index) => (
          <p role="alert" className="alert" key={`${issue.field}-${index}`}>
            {t(issue.messageKey)}
          </p>
        ))}
        <ul className="roster">
          {rosterIds.map((actorId, index) => (
            <li key={actorId}>
              <label htmlFor={`class-${actorId}`}>{t('controls.member', { actor: actorId })}</label>
              <select
                id={`class-${actorId}`}
                value={draft.classes[index]}
                onChange={(event) => setActorClass(actorId, event.target.value as ClassId)}
              >
                {CLASS_IDS.map((classId) => (
                  <option key={classId} value={classId}>
                    {t(`class.${classId}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost-button"
                aria-pressed={selectedActorId === actorId}
                onClick={() => setSelectedActorId(actorId)}
              >
                {t('controls.selectCharacter', { actor: actorId })}
              </button>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend>{t('controls.recipeAndSeed')}</legend>
        <label htmlFor="recipe">{t('controls.recipe')}</label>
        <select
          id="recipe"
          value={draft.recipe}
          onChange={(event) => setDraft((previous) => ({ ...previous, recipe: event.target.value as RecipeId | 'mixed' }))}
        >
          {[...Object.keys(content.recipes), 'mixed'].map((recipeId) => (
            <option key={recipeId} value={recipeId}>
              {t(`recipe.${recipeId}`)}
            </option>
          ))}
        </select>
        {issuesFor('recipe', issues).map((issue, index) => (
          <p role="alert" className="alert" key={`${issue.field}-${index}`}>
            {t(issue.messageKey)}
          </p>
        ))}

        <label htmlFor="seed">{t('controls.seed')}</label>
        <input
          id="seed"
          type="number"
          className="num"
          value={draft.seed}
          onChange={(event) => setDraft((previous) => ({ ...previous, seed: Number(event.target.value) }))}
        />
        {issuesFor('seed', issues).map((issue, index) => (
          <p role="alert" className="alert" key={`${issue.field}-${index}`}>
            {t(issue.messageKey)}
          </p>
        ))}
      </fieldset>

      <fieldset>
        <legend>{t('controls.placement')}</legend>
        <p className="help">{t('controls.placementHelp')}</p>
        <p aria-live="polite" className="selection">
          {selectedLabel}
        </p>
        {placementIssues.map((issue, index) => (
          <p role="alert" className="alert" key={`${issue.field}-${index}`}>
            {t(issue.messageKey)}
          </p>
        ))}
        <div role="grid" className="place-grid" aria-label={t('controls.placementGrid')}>
          {Array.from({ length: content.grid.height }, (_, row) => (
            <div role="row" key={row}>
              {Array.from({ length: content.grid.width }, (_, column) => {
                const id = cellId(column, row);
                const occupant = rosterIds.find((actorId) => draft.placement[actorId] === id) ?? null;
                const isPartyCell = content.grid.playerRows.includes(row);
                const isFocused = focusedCell.column === column && focusedCell.row === row;
                return (
                  <button
                    type="button"
                    role="gridcell"
                    key={id}
                    className={isPartyCell ? 'cell cell--party' : 'cell cell--invalid'}
                    title={isPartyCell ? t('board.cell', { position: id }) : t('controls.invalidCell')}
                    ref={(node) => {
                      cellRefs.current[id] = node;
                    }}
                    tabIndex={isFocused ? 0 : -1}
                    aria-disabled={!isPartyCell}
                    onFocus={() => setFocusedCell({ column, row })}
                    onClick={() => placeSelectedAt(column, row)}
                    onKeyDown={(event) => onCellKeyDown(event, column, row)}
                  >
                    {isPartyCell ? occupant ?? '' : t('controls.invalidCellMark')}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>{t('controls.restAndWipe')}</legend>
        <label htmlFor="rest-hp">{t('controls.restHp')}</label>
        <input
          id="rest-hp"
          type="number"
          className="num"
          value={draft.rest.hpStart}
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, rest: { ...previous.rest, hpStart: Number(event.target.value) } }))
          }
        />
        <label htmlFor="rest-mp">{t('controls.restMp')}</label>
        <input
          id="rest-mp"
          type="number"
          className="num"
          value={draft.rest.mpStart}
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, rest: { ...previous.rest, mpStart: Number(event.target.value) } }))
          }
        />
        {issuesFor('rest', issues).map((issue, index) => (
          <p role="alert" className="alert" key={`${issue.field}-${index}`}>
            {t(issue.messageKey)}
          </p>
        ))}
        <label htmlFor="wipe-limit">{t('controls.wipeLimit')}</label>
        <input
          id="wipe-limit"
          type="number"
          className="num"
          value={draft.wipeLimit}
          onChange={(event) => setDraft((previous) => ({ ...previous, wipeLimit: Number(event.target.value) }))}
        />
        {issuesFor('wipeLimit', issues).map((issue, index) => (
          <p role="alert" className="alert" key={`${issue.field}-${index}`}>
            {t(issue.messageKey)}
          </p>
        ))}
      </fieldset>

      <fieldset>
        <legend>{t('controls.strategy')}</legend>
        <p className="help">{t('controls.ruleOrderHelp')}</p>
        {rosterIds.map((actorId) => {
          const strategy = draft.strategies[actorId];
          if (!strategy) return null;
          return (
            <div key={actorId} role="group" className="strategy" aria-label={t('controls.strategyFor', { actor: actorId })}>
              <h3>{t('controls.member', { actor: actorId })}</h3>

              <label htmlFor={`target-kind-${actorId}`}>{t('controls.targetMode')}</label>
              <select
                id={`target-kind-${actorId}`}
                value={strategy.target.kind}
                onChange={(event) => setTargetKind(actorId, event.target.value as TargetMode['kind'])}
              >
                {PRIORITY_TARGET_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`targetMode.${kind}`)}
                  </option>
                ))}
                <option value="attacking">{t('targetMode.attacking')}</option>
              </select>
              {strategy.target.kind === 'attacking' && (
                <>
                  <label htmlFor={`target-party-${actorId}`}>{t('controls.watchAlly')}</label>
                  <select
                    id={`target-party-${actorId}`}
                    value={strategy.target.partyId}
                    onChange={(event) => setTargetPartyId(actorId, event.target.value)}
                  >
                    {rosterIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <ol className="rules">
                {strategy.rules.map((rule, index) => (
                  <li key={rule.skillId} id={`rule-${actorId}-${rule.skillId}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(event) => setRuleEnabled(actorId, index, event.target.checked)}
                      />
                      {t(`skill.${rule.skillId}`)}
                    </label>
                    {'value' in rule.condition && (
                      <label>
                        {t('controls.ruleThreshold')}
                        <input
                          type="number"
                          className="num"
                          value={rule.condition.value}
                          onChange={(event) => setRuleThreshold(actorId, index, Number(event.target.value))}
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      className="ghost-button"
                      aria-label={t('controls.moveRuleUp', { skill: t(`skill.${rule.skillId}`), actor: actorId })}
                      disabled={index === 0}
                      onClick={() => moveRule(actorId, index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      aria-label={t('controls.moveRuleDown', { skill: t(`skill.${rule.skillId}`), actor: actorId })}
                      disabled={index === strategy.rules.length - 1}
                      onClick={() => moveRule(actorId, index, 1)}
                    >
                      ↓
                    </button>
                  </li>
                ))}
              </ol>

              {issuesFor(`strategies.${actorId}`, issues).map((issue, index) => (
                <p role="alert" className="alert" key={`${issue.field}-${index}`}>
                  {t(issue.messageKey)}
                </p>
              ))}
            </div>
          );
        })}
      </fieldset>

      <fieldset>
        <legend>{t('controls.run')}</legend>
        <p className="help">{t('controls.startHelp')}</p>
        <div className="row">
          <button
            type="button"
            className="primary-button"
            disabled={!canStart}
            onClick={() => {
              onStart(draft);
              // Ruling R80: useExperiment.start() always begins a fresh generation's
              // clock at speed 1x, so the radio group must resync here -- otherwise
              // it can misreport (e.g. still showing 16x from a previous run) the
              // speed the new experiment is actually running at.
              setLocalSpeed(1);
            }}
          >
            {t('controls.start')}
          </button>
          <button type="button" className="ghost-button" disabled={status !== 'running'} onClick={onPause}>
            {t('controls.pause')}
          </button>
          <button type="button" className="ghost-button" disabled={status !== 'paused'} onClick={onResume}>
            {t('controls.resume')}
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={status === 'idle' || status === 'stopped'}
            onClick={onStop}
          >
            {t('controls.stop')}
          </button>
        </div>
        <fieldset>
          <legend>{t('playback.speed')}</legend>
          <div className="row">
            {SPEEDS.map((value) => (
              <label key={value} className="chip">
                <input
                  type="radio"
                  name="speed"
                  value={value}
                  checked={speed === value}
                  onChange={() => {
                    setLocalSpeed(value);
                    onSpeedChange(value);
                  }}
                />
                {t('playback.speedOption', { value: formatNumber(value, language) })}
              </label>
            ))}
          </div>
        </fieldset>
      </fieldset>
    </section>
  );
}
