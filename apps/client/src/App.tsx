/**
 * The Realm HUD.
 *
 * `codex-examples/realm-refined/hunt.html` is the approved design. Its stylesheet
 * is ported verbatim into `styles.css` and its regions are ported into
 * `src/hud/*`, so this file is only the composition: the `.realm` fixed viewport
 * and the regions the reference anchors inside it.
 *
 * Everything on screen comes from a real `PublicState`. Milestone A publishes no
 * loot, wallet, inventory, zone, level curve, buff list or threat table, so the
 * reference's panels for those are either bound to a measured figure of the same
 * shape or left out — never filled with a placeholder. `src/hud/model.ts` records
 * which is which.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { content } from '@narok/data';
import type { LabInput } from '@narok/sim';
import type { ComparisonRun } from './Comparison';
import { Battlefield } from './hud/Battlefield';
import { ChatPanel } from './hud/ChatPanel';
import { CommandBar } from './hud/CommandBar';
import { Compass } from './hud/Compass';
import { LabStrip } from './hud/LabStrip';
import { OrdersPanel } from './hud/OrdersPanel';
import { PartyPanel } from './hud/PartyPanel';
import { RunsPanel } from './hud/RunsPanel';
import { SessionPanel } from './hud/SessionPanel';
import { SetupOverlay } from './hud/SetupOverlay';
import { SpriteSheet } from './hud/SpriteSheet';
import { TargetFrame } from './hud/TargetFrame';
import { WorldBackdrop } from './hud/WorldBackdrop';
import { buildSessionExport, downloadJson, sessionExportFilename } from './exportSession';
import { EVENT_HISTORY_LIMIT, useExperiment } from './useExperiment';

export function App(): React.JSX.Element {
  const { t } = useTranslation();

  const { state, events, status, comparisonA, comparisonB, start, pause, resume, stop, setSpeed } =
    useExperiment();

  const [inspected, setInspected] = useState<{ actorId: string; skillId: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [speed, setLocalSpeed] = useState(1);
  const [setupOpen, setSetupOpen] = useState(true);

  // The input the *running* experiment was started with. Editing the draft
  // afterwards never touches it; only a new start replaces it.
  const [activeInput, setActiveInput] = useState<LabInput | null>(null);
  // The draft the setup form currently describes, so the Orders window can start
  // it without owning the form's state. It is held in state because the compass
  // renders from it — a ref alone would leave the recipe stale
  // whenever the draft changed without `canStart` changing with it — and mirrored
  // into a ref so `onStartDraft` never closes over a stale copy.
  const [draft, setDraft] = useState<{ input: LabInput | null; canStart: boolean }>({
    input: null,
    canStart: false,
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const onDraftChange = useCallback((input: LabInput, startable: boolean) => {
    setDraft((current) =>
      current.input === input && current.canStart === startable ? current : { input, canStart: startable },
    );
  }, []);

  const onStart = useCallback(
    (input: LabInput) => {
      setActiveInput(input);
      setInspected(null);
      // Ruling R80: a fresh generation's clock always begins at 1x.
      setLocalSpeed(1);
      setSetupOpen(false);
      start(input);
    },
    [start],
  );

  const onStartDraft = useCallback(() => {
    const { input, canStart: startable } = draftRef.current;
    if (input === null || !startable) return;
    onStart(input);
  }, [onStart]);

  const onStop = useCallback(() => {
    stop();
    // A finished run is the moment to set up the next one.
    setSetupOpen(true);
  }, [stop]);

  const onSpeedChange = useCallback(
    (next: number) => {
      setLocalSpeed(next);
      setSpeed(next);
    },
    [setSpeed],
  );

  /**
   * Writes the whole session to a local JSON file. Enabled as soon as a run has
   * started, because a run that errored or stopped early is exactly the one worth
   * sending on. `simulationVersion` is the literal `'b1'` the sim stamps into
   * every state; the projection does not carry it and `PublicState` is not ours
   * to extend (ruling R83), so this mirrors `tools/balance`'s benchmark metadata.
   */
  const onExport = useCallback(() => {
    const bundle = buildSessionExport({
      versions: {
        simulationVersion: 'b1',
        contentVersion: content.version,
        gridHash: content.gridHash,
      },
      status,
      input: activeInput,
      state,
      events,
      eventHistoryLimit: EVENT_HISTORY_LIMIT,
      comparisonA,
      comparisonB,
      now: () => new Date(),
    });
    downloadJson(sessionExportFilename(bundle), bundle);
  }, [status, activeInput, state, events, comparisonA, comparisonB]);

  const canExport = activeInput !== null || comparisonA !== null || comparisonB !== null;

  // Slot A is the earlier retained run, slot B the latest (R54/R63).
  const runs = useMemo<ComparisonRun[]>(
    () =>
      [comparisonA, comparisonB]
        .filter((summary) => summary !== null)
        .map((summary) => ({ input: summary.input, state: summary.state })),
    [comparisonA, comparisonB],
  );

  // The run the compass describes: the live one while it lasts, else the draft.
  const shownInput = activeInput ?? draft.input;

  // Keep the inspected skill and the selected member honest across roster changes.
  useEffect(() => {
    if (state === null) return;
    const ids = new Set(state.actors.filter((actor) => actor.side === 'party').map((actor) => actor.id));
    if (selectedId !== null && !ids.has(selectedId)) setSelectedId(null);
    if (inspected !== null && !ids.has(inspected.actorId)) setInspected(null);
  }, [state, selectedId, inspected]);

  const onCloseSetup = useCallback(() => setSetupOpen(false), []);
  const onToggleSetup = useCallback(() => setSetupOpen((open) => !open), []);

  /**
   * The approved stylesheet already ships the switch
   * (`styles.css`: `body[data-paused="true"] .realm * { animation-play-state: paused }`)
   * but nothing was writing the attribute, so the world's fog, embers, sparks,
   * target rings and cast bars ran forever — including while the lab sat idle
   * with no experiment loaded, or paused behind the setup form. Animations now
   * run exactly while the hunt does.
   */
  useEffect(() => {
    const paused = status !== 'running';
    document.body.dataset.paused = paused ? 'true' : 'false';
    return () => {
      delete document.body.dataset.paused;
    };
  }, [status]);

  const onInspect = useCallback((actorId: string, skillId: string) => {
    setInspected((current) =>
      current !== null && current.actorId === actorId && current.skillId === skillId
        ? null
        : { actorId, skillId },
    );
    setSelectedId(actorId);
  }, []);

  return (
    <div className="realm">
      <SpriteSheet />
      <WorldBackdrop />
      <Battlefield state={state} grid={content.grid} events={events} />

      <TargetFrame state={state} />

      {/* The reference's left column is party + session and is sized to fit
          above the chat window; adding a third panel here clipped the session's
          figures, so the laboratory's own readouts live in the rail, which
          scrolls. */}
      <div className="leftcol">
        <PartyPanel state={state} selectedId={selectedId} onSelect={setSelectedId} />
        <SessionPanel state={state} />
      </div>

      <aside className="rail" aria-label={t('app.session')}>
        <LabStrip state={state} status={status} canExport={canExport} onExport={onExport} />
        <Compass
          state={state}
          grid={content.grid}
          status={status}
          recipeId={shownInput?.recipe ?? null}
        />
        <RunsPanel runs={runs} />
        <OrdersPanel
          status={status}
          speed={speed}
          canStart={draft.canStart}
          onStart={onStartDraft}
          onPause={pause}
          onResume={resume}
          onStop={onStop}
          onSpeedChange={onSpeedChange}
          onOpenSetup={onToggleSetup}
        />
      </aside>

      <ChatPanel events={events} actors={state?.actors ?? []} />

      <CommandBar state={state} selectedId={selectedId} inspected={inspected} onInspect={onInspect} />

      <SetupOverlay
        open={setupOpen}
        content={content}
        status={status}
        onStart={onStart}
        onPause={pause}
        onResume={resume}
        onStop={onStop}
        onSpeedChange={onSpeedChange}
        onDraftChange={onDraftChange}
        onClose={onCloseSetup}
      />
    </div>
  );
}
