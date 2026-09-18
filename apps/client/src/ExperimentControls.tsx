/**
 * Setup and run controls (ruling R55). Edits a draft `LabInput` separately from
 * whatever experiment is currently running — changing the draft never mutates a
 * running experiment; pressing "Start" hands the draft to `onStart`, which the
 * hook turns into a new generation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Content, ClassId, RecipeId } from '@narok/data';
import type { ActorId, LabInput, PositionId, Strategy, TargetMode } from '@narok/sim';
import { defaultStrategy, gridPosition } from '@narok/sim';
import type { ExperimentStatus } from './useExperiment';
import { validateLabInput, type ValidationIssue } from './validation';

const CLASS_IDS: ClassId[] = ['guardian', 'cleric', 'ranger', 'arcanist'];
const SPEEDS = [1, 4, 16] as const;
const PRIORITY_TARGET_KINDS = ['lowest-hp', 'highest-hp', 'highest-level', 'nearest'] as const;

/** Trivial local key -> English lookup. Task 10 replaces this with react-i18next and adds PT-BR. */
const MESSAGES: Record<string, string> = {
  'validation.rosterSize': 'Roster must have 1 to 3 members.',
  'validation.unknownClass': 'Unknown class.',
  'validation.seedRange': 'Seed must be an integer between 1 and 4,294,967,295.',
  'validation.unknownRecipe': 'Unknown recipe.',
  'validation.unknownPlacement': 'Every roster member needs a placement.',
  'validation.duplicatePlacement': 'Two members cannot share a cell.',
  'validation.invalidCell': 'That cell is outside the party zone.',
  'validation.restRange': 'Rest HP must be 0-89% and rest MP must be 0-79%.',
  'validation.wipeLimit': 'Wipe limit must be between 1 and 5.',
  'validation.ruleThreshold': 'That threshold is outside its allowed range.',
  'validation.unknownTargetParty': 'That character is no longer in the roster.',
};

function translate(messageKey: string): string {
  return MESSAGES[messageKey] ?? messageKey;
}

function cellId(column: number, row: number): PositionId {
  return gridPosition(column, row);
}

function defaultDraft(): LabInput {
  const classes: ClassId[] = ['guardian', 'cleric', 'ranger'];
  const strategies: Record<ActorId, Strategy> = {};
  classes.forEach((classId, index) => {
    strategies[`p${index}`] = defaultStrategy(classId);
  });
  return {
    seed: 1,
    classes,
    recipe: 'mixed',
    placement: {},
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
  const [draft, setDraft] = useState<LabInput>(defaultDraft);
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

  const setRosterSize = useCallback((size: number) => {
    setDraft((previous) => {
      const classes = [...previous.classes];
      while (classes.length < size) classes.push('guardian');
      classes.length = size;
      const ids = classes.map((_, index) => `p${index}`);
      const strategies: Record<ActorId, Strategy> = {};
      const placement: Record<ActorId, PositionId> = {};
      ids.forEach((id, index) => {
        strategies[id] = previous.strategies[id] ?? defaultStrategy(classes[index]);
        if (previous.placement[id]) placement[id] = previous.placement[id];
      });
      return { ...previous, classes, strategies, placement };
    });
    setSelectedActorId(null);
  }, []);

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
    ? `Selected: ${draft.classes[Number(selectedActorId.slice(1))]} (${selectedActorId})`
    : 'No character selected.';

  const placementIssues = issuesFor('placement', issues);
  const canStart = issues.length === 0;

  return (
    <section aria-label="Experiment controls">
      <fieldset>
        <legend>Roster</legend>
        {[1, 2, 3].map((size) => (
          <label key={size}>
            <input
              type="radio"
              name="roster-size"
              value={size}
              checked={draft.classes.length === size}
              onChange={() => setRosterSize(size)}
            />
            {size}
          </label>
        ))}
        {issuesFor('classes', issues).map((issue, index) => (
          <p role="alert" key={`${issue.field}-${index}`}>
            {translate(issue.messageKey)}
          </p>
        ))}
        <ul>
          {rosterIds.map((actorId, index) => (
            <li key={actorId}>
              <label htmlFor={`class-${actorId}`}>{actorId}</label>
              <select
                id={`class-${actorId}`}
                value={draft.classes[index]}
                onChange={(event) => setActorClass(actorId, event.target.value as ClassId)}
              >
                {CLASS_IDS.map((classId) => (
                  <option key={classId} value={classId}>
                    {classId}
                  </option>
                ))}
              </select>
              <button type="button" aria-pressed={selectedActorId === actorId} onClick={() => setSelectedActorId(actorId)}>
                Select {actorId}
              </button>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend>Recipe and seed</legend>
        <label htmlFor="recipe">Recipe</label>
        <select
          id="recipe"
          value={draft.recipe}
          onChange={(event) => setDraft((previous) => ({ ...previous, recipe: event.target.value as RecipeId | 'mixed' }))}
        >
          {[...Object.keys(content.recipes), 'mixed'].map((recipeId) => (
            <option key={recipeId} value={recipeId}>
              {recipeId}
            </option>
          ))}
        </select>
        {issuesFor('recipe', issues).map((issue, index) => (
          <p role="alert" key={`${issue.field}-${index}`}>
            {translate(issue.messageKey)}
          </p>
        ))}

        <label htmlFor="seed">Seed</label>
        <input
          id="seed"
          type="number"
          value={draft.seed}
          onChange={(event) => setDraft((previous) => ({ ...previous, seed: Number(event.target.value) }))}
        />
        {issuesFor('seed', issues).map((issue, index) => (
          <p role="alert" key={`${issue.field}-${index}`}>
            {translate(issue.messageKey)}
          </p>
        ))}
      </fieldset>

      <fieldset>
        <legend>Placement</legend>
        <p aria-live="polite">{selectedLabel}</p>
        {placementIssues.map((issue, index) => (
          <p role="alert" key={`${issue.field}-${index}`}>
            {translate(issue.messageKey)}
          </p>
        ))}
        <div role="grid" aria-label="Battlefield placement grid">
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
                    ref={(node) => {
                      cellRefs.current[id] = node;
                    }}
                    tabIndex={isFocused ? 0 : -1}
                    aria-disabled={!isPartyCell}
                    onFocus={() => setFocusedCell({ column, row })}
                    onClick={() => placeSelectedAt(column, row)}
                    onKeyDown={(event) => onCellKeyDown(event, column, row)}
                  >
                    {isPartyCell ? occupant ?? '' : '×'}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Rest and wipe limit</legend>
        <label htmlFor="rest-hp">Rest HP %</label>
        <input
          id="rest-hp"
          type="number"
          value={draft.rest.hpStart}
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, rest: { ...previous.rest, hpStart: Number(event.target.value) } }))
          }
        />
        <label htmlFor="rest-mp">Rest MP %</label>
        <input
          id="rest-mp"
          type="number"
          value={draft.rest.mpStart}
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, rest: { ...previous.rest, mpStart: Number(event.target.value) } }))
          }
        />
        {issuesFor('rest', issues).map((issue, index) => (
          <p role="alert" key={`${issue.field}-${index}`}>
            {translate(issue.messageKey)}
          </p>
        ))}
        <label htmlFor="wipe-limit">Wipe limit</label>
        <input
          id="wipe-limit"
          type="number"
          value={draft.wipeLimit}
          onChange={(event) => setDraft((previous) => ({ ...previous, wipeLimit: Number(event.target.value) }))}
        />
        {issuesFor('wipeLimit', issues).map((issue, index) => (
          <p role="alert" key={`${issue.field}-${index}`}>
            {translate(issue.messageKey)}
          </p>
        ))}
      </fieldset>

      <fieldset>
        <legend>Strategy rules</legend>
        {rosterIds.map((actorId) => {
          const strategy = draft.strategies[actorId];
          if (!strategy) return null;
          return (
            <div key={actorId} role="group" aria-label={`Strategy: ${actorId}`}>
              <h3>{actorId}</h3>

              <label htmlFor={`target-kind-${actorId}`}>Target mode</label>
              <select
                id={`target-kind-${actorId}`}
                value={strategy.target.kind}
                onChange={(event) => setTargetKind(actorId, event.target.value as TargetMode['kind'])}
              >
                {PRIORITY_TARGET_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
                <option value="attacking">attacking</option>
              </select>
              {strategy.target.kind === 'attacking' && (
                <>
                  <label htmlFor={`target-party-${actorId}`}>Watch ally</label>
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

              <ol>
                {strategy.rules.map((rule, index) => (
                  <li key={rule.skillId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(event) => setRuleEnabled(actorId, index, event.target.checked)}
                      />
                      {rule.skillId}
                    </label>
                    {'value' in rule.condition && (
                      <label>
                        threshold
                        <input
                          type="number"
                          value={rule.condition.value}
                          onChange={(event) => setRuleThreshold(actorId, index, Number(event.target.value))}
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      aria-label={`Move ${rule.skillId} up for ${actorId}`}
                      disabled={index === 0}
                      onClick={() => moveRule(actorId, index, -1)}
                    >
                      Move up
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${rule.skillId} down for ${actorId}`}
                      disabled={index === strategy.rules.length - 1}
                      onClick={() => moveRule(actorId, index, 1)}
                    >
                      Move down
                    </button>
                  </li>
                ))}
              </ol>

              {issuesFor(`strategies.${actorId}`, issues).map((issue, index) => (
                <p role="alert" key={`${issue.field}-${index}`}>
                  {translate(issue.messageKey)}
                </p>
              ))}
            </div>
          );
        })}
      </fieldset>

      <fieldset>
        <legend>Run</legend>
        <button
          type="button"
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
          Start
        </button>
        <button type="button" disabled={status !== 'running'} onClick={onPause}>
          Pause
        </button>
        <button type="button" disabled={status !== 'paused'} onClick={onResume}>
          Resume
        </button>
        <button type="button" disabled={status === 'idle' || status === 'stopped'} onClick={onStop}>
          Stop
        </button>
        <fieldset>
          <legend>Speed</legend>
          {SPEEDS.map((value) => (
            <label key={value}>
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
              {value}x
            </label>
          ))}
        </fieldset>
      </fieldset>
    </section>
  );
}
