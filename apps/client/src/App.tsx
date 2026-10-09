/**
 * The Realm HUD over the server's authoritative hunt (milestone B Task 9).
 *
 * `codex-examples/realm-refined/hunt.html` is the approved design. Its stylesheet
 * is ported verbatim into `styles.css` and its regions are ported into
 * `src/hud/*`, so this file is only the composition: the `.realm` fixed viewport
 * and the regions the reference anchors inside it, fed by `useHunt`.
 *
 * The client runs no simulation (gate B-02). Milestone A's laboratory moved to
 * `apps/lab` and composes the same HUD from `@narok/client` (ruling R164: the lab
 * may import the client, the client never imports the lab). Here every region is
 * fed what the socket released behind the render horizon (`playback.ts`), and
 * the account reads — wallet, bag occupancy, zone — the server publishes; a
 * figure the server does not publish is left out, never filled in (R108).
 *
 * Every mutation is a command (part 4 §3.1): Start hunt and Stop in the Orders
 * window, Save preset and Apply next encounter on the Strategy screen. Each is
 * shown pending until the server answers; a refusal is rendered from the
 * server's stable code (`serverError.<CODE>`).
 *
 * Milestone B Task 10 adds three routes over the same `useHunt` account state
 * — Bag, Character and Away — so one coherent account state feeds every
 * screen and their counters reconcile (part 4 §4). Strategy stays the
 * `SetupOverlay` panel R113 exists for. Each town screen mounts its own
 * stylesheet while it is shown and removes it when it closes (ruling R181).
 * A report notice from the socket opens Away once per report id.
 *
 * Ruling R190: wherever a loot filter is named — the Orders window, Away's
 * "Current loot filter", the Bag's filter pane — it is the running hunt's
 * active loot preset (`HuntResponse.activeLoot`), and in town the preset a
 * start would use; because the first preset in the list is only an
 * alphabetical accident, and naming a filter the hunt is not running misleads
 * the player about what happens to their drops (part 4 §3.3, §4).
 *
 * Ruling R195: town commands reach their screens unswallowed, and each screen
 * renders its own command's refusal; the hook's `commandError` stays the Hunt
 * shell's.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { content, type ClassId } from '@narok/data';
import { Battlefield } from './hud/Battlefield';
import { ChatPanel } from './hud/ChatPanel';
import { CommandBar } from './hud/CommandBar';
import { Compass } from './hud/Compass';
import { OrdersPanel } from './hud/OrdersPanel';
import { PartyPanel } from './hud/PartyPanel';
import { SessionPanel } from './hud/SessionPanel';
import { SpriteSheet } from './hud/SpriteSheet';
import { TargetFrame } from './hud/TargetFrame';
import { WorldBackdrop } from './hud/WorldBackdrop';
import { StrategyScreen } from './hud/strategy/StrategyScreen';
import { SHOP_ENABLED } from './features';
import type { BagCommands } from './town/BagScreen';
import { SALE_KIT } from './town/SaleControls';
import { useHunt, type UseHuntOptions } from './useHunt';

export type Route = 'hunt' | 'bag' | 'character' | 'away';

// Each town screen is its own chunk, loaded when first opened: it carries its
// own ported sheet as text (R181), and Hunt — the screen a session opens on —
// should not pay for three screens it may never show.
const BagScreen = lazy(() => import('./town/BagScreen').then((module) => ({ default: module.BagScreen })));
const CharacterScreen = lazy(() => import('./town/CharacterScreen').then((module) => ({ default: module.CharacterScreen })));
const AwayReport = lazy(() => import('./town/AwayReport').then((module) => ({ default: module.AwayReport })));

/** Swallows a refusal the hook has already recorded as `commandError` (the flagged sale only, R185). */
const settled = (promise: Promise<void>): Promise<void> => promise.catch(() => undefined);

export interface AppProps {
  /** The hook's collaborators; tests substitute the socket, the clock and the API (R56). */
  huntOptions?: UseHuntOptions;
}

export function App({ huntOptions }: AppProps = {}): React.JSX.Element {
  const { t } = useTranslation();
  const hunt = useHunt(huntOptions);
  const { state, events, status } = hunt;

  const [inspected, setInspected] = useState<{ actorId: string; skillId: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [route, setRoute] = useState<Route>('hunt');

  // A newly read report opens Away, once per report id; reopening it is a read.
  const shownReport = useRef<string | null>(null);
  useEffect(() => {
    if (hunt.report === null || hunt.reportId === null || shownReport.current === hunt.reportId) return;
    shownReport.current = hunt.reportId;
    setRoute('away');
  }, [hunt.report, hunt.reportId]);

  /**
   * `styles.css` pauses the world's ambient animation under
   * `body[data-paused="true"]`. It tracks the *authoritative* hunt status, not
   * the playback state (R110): a client that is buffering, resynchronising or
   * reconnecting is still watching a running hunt.
   */
  useEffect(() => {
    document.body.dataset.paused = status === 'running' ? 'false' : 'true';
    return () => {
      delete document.body.dataset.paused;
    };
  }, [status]);

  // Keep the inspected skill and the selected member honest across roster changes.
  useEffect(() => {
    if (state === null) return;
    const ids = new Set(state.actors.filter((actor) => actor.side === 'party').map((actor) => actor.id));
    if (selectedId !== null && !ids.has(selectedId)) setSelectedId(null);
    if (inspected !== null && !ids.has(inspected.actorId)) setInspected(null);
  }, [state, selectedId, inspected]);

  const onInspect = useCallback((actorId: string, skillId: string) => {
    setInspected((current) =>
      current !== null && current.actorId === actorId && current.skillId === skillId ? null : { actorId, skillId },
    );
    setSelectedId(actorId);
  }, []);

  const strategyPresets = hunt.presets?.strategy ?? [];
  // While a hunt runs the Orders window names the strategy it is running, not
  // the editor's selected tab, which is only what a start would use (§3.1).
  const namedPresetId = status === 'running' ? (hunt.hunt?.activeStrategy.presetId ?? null) : hunt.selectedPresetId;
  const strategyName = strategyPresets.find((preset) => preset.id === namedPresetId)?.name ?? null;
  const classes = hunt.characters.slice(0, 3).map((character) => character.classId as ClassId);
  const wallet =
    hunt.inventory === null
      ? null
      : { gold: hunt.inventory.gold, usedSlots: hunt.inventory.usedSlots, capacity: hunt.inventory.capacity };
  const fault = hunt.commandError ?? hunt.error;
  const hunting = status === 'running';
  const lootPresets = hunt.presets?.loot ?? [];
  const zone = hunt.hunt?.mapId ?? null;
  // R190: the loot filter the hunt runs; in town, the one a start would use.
  const activeLootId = hunting ? (hunt.hunt?.activeLoot?.presetId ?? null) : hunt.startLootPresetId;
  const pendingLootId = hunting ? (hunt.hunt?.pendingLoot?.presetId ?? null) : null;
  const lootFilterName = lootPresets.find((preset) => preset.id === activeLootId)?.name ?? null;

  // R195: refusals reach the screen that sent the command.
  const bagCommands: BagCommands = {
    equip: hunt.town.equip,
    lock: hunt.town.lock,
    applyLoot: hunt.town.applyLoot,
    sell: (itemIds) => settled(hunt.town.sell(itemIds)),
  };

  if (route === 'bag') {
    return (
      <Suspense fallback={<div className="realm" />}>
        <BagScreen
        content={content}
        inventory={hunt.inventory}
        characters={hunt.characters}
        lootPresets={lootPresets}
        activeLootId={activeLootId}
        pendingLootId={pendingLootId}
        hunting={hunting}
        zone={zone}
        commands={bagCommands}
        sale={SHOP_ENABLED ? SALE_KIT : null}
        onBack={() => setRoute('hunt')}
        />
      </Suspense>
    );
  }

  if (route === 'character') {
    return (
      <Suspense fallback={<div className="realm" />}>
        <CharacterScreen
        content={content}
        characters={hunt.characters}
        inventory={hunt.inventory}
        hunting={hunting}
        zone={zone}
        commands={hunt.town}
        onNavigate={setRoute}
        />
      </Suspense>
    );
  }

  if (route === 'away' && hunt.report !== null) {
    return (
      <Suspense fallback={<div className="realm" />}>
        <AwayReport
        report={hunt.report}
        content={content}
        characters={hunt.characters}
        inventory={hunt.inventory}
        lootPresetName={lootFilterName}
        onManageBag={() => setRoute('bag')}
        onReturnToHunt={() => setRoute('hunt')}
        onStartHunt={() => {
          setRoute('hunt');
          hunt.start();
        }}
        onReviewFilter={() => setRoute('bag')}
        />
      </Suspense>
    );
  }

  return (
    <div className="realm">
      <SpriteSheet />
      <WorldBackdrop />
      <Battlefield state={state} grid={content.grid} events={events} />

      <TargetFrame state={state} />

      <div className="leftcol">
        <PartyPanel state={state} selectedId={selectedId} onSelect={setSelectedId} />
        <SessionPanel state={state} />
      </div>

      <aside className="rail" aria-label={t('app.session')}>
        <Compass
          state={state}
          grid={content.grid}
          status={status}
          recipeId={null}
          zone={hunt.hunt?.mapId ?? null}
          wallet={wallet}
          playback={hunt.playback}
        />
        <OrdersPanel
          status={status}
          stopReason={hunt.stopReason}
          faulted={hunt.faulted}
          canStart={hunt.canStart}
          pending={hunt.pending}
          strategyName={strategyName}
          onStart={hunt.start}
          onStop={hunt.stop}
          onRecover={hunt.recover}
          onOpenStrategy={() => setStrategyOpen(true)}
          lootFilterName={lootFilterName}
          onOpenBag={() => setRoute('bag')}
          onOpenCharacter={() => setRoute('character')}
          partyLabel={hunt.characters.length === 0 ? null : hunt.characters.map((character) => character.name).join(', ')}
        />
        {fault !== null && (
          <p className="hint" role="alert" data-testid="hunt-fault">
            {t(`serverError.${fault.code}`)}
          </p>
        )}
        {hunt.reportId !== null && (
          <p className="hint" role="status">
            {t('hunt.report')}{' '}
            {hunt.report !== null && (
              <button className="preset-edit" type="button" onClick={() => setRoute('away')}>
                {t('hunt.openReport')}
              </button>
            )}
          </p>
        )}
      </aside>

      <ChatPanel events={events} actors={state?.actors ?? []} />

      <CommandBar state={state} selectedId={selectedId} inspected={inspected} onInspect={onInspect} />

      <StrategyScreen
        open={strategyOpen}
        content={content}
        presets={strategyPresets}
        classes={classes}
        selectedPresetId={hunt.selectedPresetId}
        onSelectPreset={hunt.selectPreset}
        active={hunt.hunt?.activeStrategy ?? null}
        pending={hunt.hunt?.pendingStrategy ?? null}
        status={status}
        commands={hunt.strategy}
        onClose={() => setStrategyOpen(false)}
      />
    </div>
  );
}
