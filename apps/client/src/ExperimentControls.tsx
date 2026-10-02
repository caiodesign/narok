/**
 * Setup and run controls (ruling R55). Edits a draft `LabInput` separately from
 * whatever experiment is currently running — changing the draft never mutates a
 * running experiment; pressing "Start experiment" hands the draft to `onStart`,
 * which the hook turns into a new generation.
 *
 * Milestone B adds a second variant (part 4 §3.2): `variant="preset"` edits a
 * saved strategy preset — placement, rules and rest — for the account's own
 * party. The draft is then *controlled*: the Strategy screen
 * (`hud/strategy/StrategyScreen.tsx`) owns it beside the saved version, so
 * Revert, Save and Apply act on the same object this form edits. Edits still
 * mutate the draft only and issue no command. There is no Pause or Resume in
 * either variant (ruling R166): the laboratory's pausable clock is driven from
 * its own orders panel in `apps/lab`.
 *
 * Every visible string comes from `t()` (ruling R60); the run buttons carry the
 * accessible names ruling R81 fixes for the Task 11 smoke test.
 *
 * This file owns the draft and nothing else. Since the Strategy screen was
 * ported it renders three panes from `hud/strategy/` — Formation, the character
 * rules and the party rules — in the three columns
 * `codex-examples/realm-refined/strategy.html` lays them out in. The state, the
 * seating rules, the keyboard model (R77) and the validation are unchanged; only
 * the markup moved.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Content, ClassId } from '@narok/data';
import { defaultPlacement, defaultStrategy, gridPosition } from '@narok/data';
import type { ActorId, LabInput, PositionId, Strategy, TargetMode } from '@narok/sim';
import { formatNumber, type Translate } from './i18n';
import { CharacterPane } from './hud/strategy/CharacterPane';
import { FormationPane } from './hud/strategy/FormationPane';
import { PartyRulesPane } from './hud/strategy/PartyRulesPane';
import type { ExperimentStatus } from './status';
import { validateLabInput, validatePresetDraft, type PresetDraft, type ValidationIssue } from './validation';

/** The draft this form edits: a preset's fields, plus the laboratory's seed and recipe. */
export type EditorDraft = PresetDraft & Partial<Pick<LabInput, 'seed' | 'recipe'>>;

const SPEEDS = [1, 4, 16] as const;

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
  };
}

function issuesFor(field: string, issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((issue) => issue.field === field || issue.field.startsWith(`${field}.`));
}

export interface ExperimentControlsProps {
  content: Content;
  status?: ExperimentStatus;
  onStart?: (input: LabInput) => void;
  onStop?: () => void;
  onSpeedChange?: (speed: number) => void;
  /** `experiment` (the laboratory, the default) or `preset` (a saved strategy preset, milestone B). */
  variant?: 'experiment' | 'preset';
  /** A controlled draft; when given, edits are reported through `onDraftEdit` and never held here. */
  draft?: EditorDraft;
  onDraftEdit?: (draft: EditorDraft) => void;
  /** Characters whose rules differ from the saved preset (the reference's unsaved pips). */
  unsavedActors?: ReadonlySet<ActorId>;
  /**
   * The Realm HUD promotes start/pause/stop into the `.orders` window, where the
   * reference puts a hunt's primary action. Two copies of a button would give the
   * page two controls sharing one accessible name, so the HUD passes `false` and
   * owns the transport itself. Rendered on its own the component keeps them,
   * which is what this component's own tests exercise.
   */
  showRunControls?: boolean;
  /**
   * Reports the draft and whether it is startable, so the Orders window can start
   * the run this form describes without owning the form's state.
   */
  onDraftChange?: (draft: LabInput, canStart: boolean) => void;
}

export function ExperimentControls({
  content,
  status = 'idle',
  onStart,
  onStop,
  onSpeedChange,
  variant = 'experiment',
  draft: controlledDraft,
  onDraftEdit,
  unsavedActors,
  showRunControls = true,
  onDraftChange,
}: ExperimentControlsProps): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;
  const preset = variant === 'preset';

  const [localDraft, setLocalDraft] = useState<EditorDraft>(() => controlledDraft ?? defaultDraft(content.grid));
  const draft = controlledDraft ?? localDraft;
  // Every edit below is written as `previous => next`. Controlled, `previous`
  // is the draft the parent last rendered, and the result goes back up.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editRef = useRef(onDraftEdit);
  editRef.current = onDraftEdit;
  const controlled = controlledDraft !== undefined;
  const controlledRef = useRef(controlled);
  controlledRef.current = controlled;
  const setDraft = useCallback((update: (previous: EditorDraft) => EditorDraft) => {
    if (!controlledRef.current) {
      setLocalDraft(update);
      return;
    }
    const next = update(draftRef.current);
    if (next === draftRef.current) return;
    draftRef.current = next;
    editRef.current?.(next);
  }, []);
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
  /** Which character's rules the Strategy pane is showing; its tabs pick it. */
  const [activeActorId, setActiveActorId] = useState<ActorId>('p0');
  const cellRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const registerCell = useCallback((id: PositionId, node: HTMLButtonElement | null) => {
    cellRefs.current[id] = node;
  }, []);

  const rosterIds = useMemo<ActorId[]>(() => draft.classes.map((_, index) => `p${index}`), [draft.classes]);

  // Shrinking the roster can retire the character whose rules are on screen.
  const activeIsGone = !rosterIds.includes(activeActorId);
  const shownActorId = activeIsGone ? (rosterIds[rosterIds.length - 1] ?? 'p0') : activeActorId;
  const issues = useMemo(
    () => (preset ? validatePresetDraft(draft, content) : validateLabInput(draft as LabInput, content)),
    [draft, content, preset],
  );

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

  /** The design's "Class default" foot: spec section 8's seating, recomputed. */
  const resetPlacement = useCallback(() => {
    setDraft((previous) => ({ ...previous, placement: seatRoster(previous.classes, content.grid) }));
  }, [content.grid]);

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

  // Publish the draft so a transport rendered outside this form (the HUD's
  // `.orders` window) starts exactly the run the form currently describes.
  useEffect(() => {
    if (!preset) onDraftChange?.(draft as LabInput, canStart);
  }, [draft, canStart, onDraftChange, preset]);

  return (
    <>
      {showRunControls && !preset ? (
        <section className="pane" aria-label={t('controls.run')}>
          <h2 className="win-title">{t('controls.run')}</h2>
          <div className="pane-body">
            <p className="hint">{t('controls.startHelp')}</p>
            <div className="run-actions">
              <button
                type="button"
                className="btn btn--save"
                disabled={!canStart}
                onClick={() => {
                  onStart?.(draft as LabInput);
                  // Ruling R80: useExperiment.start() always begins a fresh generation's
                  // clock at speed 1x, so the radio group must resync here -- otherwise
                  // it can misreport (e.g. still showing 16x from a previous run) the
                  // speed the new experiment is actually running at.
                  setLocalSpeed(1);
                }}
              >
                {t('controls.start')}
              </button>
              <button
                type="button"
                className="btn"
                disabled={status === 'idle' || status === 'stopped'}
                onClick={() => onStop?.()}
              >
                {t('controls.stop')}
              </button>
            </div>
            <fieldset className="chips chips--inline" style={{ marginTop: 8 }}>
              <legend className="rule-label">{t('playback.speed')}</legend>
              {SPEEDS.map((value) => (
                <label key={value} className="chip">
                  <input
                    type="radio"
                    name="speed"
                    value={value}
                    checked={speed === value}
                    onChange={() => {
                      setLocalSpeed(value);
                      onSpeedChange?.(value);
                    }}
                  />
                  <span>{t('playback.speedOption', { value: formatNumber(value, language) })}</span>
                </label>
              ))}
            </fieldset>
          </div>
        </section>
      ) : null}

      <div className="editor-body">
        <div className="col">
          <FormationPane
            grid={content.grid}
            rosterIds={rosterIds}
            classes={draft.classes}
            placement={draft.placement}
            cellId={cellId}
            selectedActorId={selectedActorId}
            focusedCell={focusedCell}
            registerCell={registerCell}
            onFocusCell={(column, row) => setFocusedCell({ column, row })}
            onPlace={placeSelectedAt}
            onCellKeyDown={onCellKeyDown}
            onResetPlacement={resetPlacement}
            onSelectForPlacement={setSelectedActorId}
            selectionLabel={selectedLabel}
            issues={placementIssues}
          />
        </div>

        <div className="col">
          <CharacterPane
            content={content}
            rosterIds={rosterIds}
            classes={draft.classes}
            strategies={draft.strategies}
            activeActorId={shownActorId}
            onActivate={setActiveActorId}
            onClassChange={(actorId, classId) => setActorClass(actorId, classId as ClassId)}
            onRuleEnabled={setRuleEnabled}
            onRuleThreshold={setRuleThreshold}
            onMoveRule={moveRule}
            onTargetKind={setTargetKind}
            onTargetPartyId={setTargetPartyId}
            issuesFor={(field) => issuesFor(field, issues)}
            unsavedActors={unsavedActors}
            classLocked={preset}
          />
        </div>

        <div className="col">
          <PartyRulesPane
            content={content}
            draft={draft}
            onRosterSize={preset ? undefined : setRosterSize}
            onRecipe={preset ? undefined : (recipe) => setDraft((previous) => ({ ...previous, recipe }))}
            onSeed={preset ? undefined : (seed) => setDraft((previous) => ({ ...previous, seed }))}
            onRest={(part, value) =>
              setDraft((previous) => ({ ...previous, rest: { ...previous.rest, [part]: value } }))
            }
            issuesFor={(field) => issuesFor(field, issues)}
          />
        </div>
      </div>
    </>
  );
}
