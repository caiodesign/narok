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
 */
import { useCallback, useEffect, useState } from 'react';
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
import { useHunt, type UseHuntOptions } from './useHunt';

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
  const strategyName = strategyPresets.find((preset) => preset.id === hunt.selectedPresetId)?.name ?? null;
  const classes = hunt.characters.slice(0, 3).map((character) => character.classId as ClassId);
  const wallet =
    hunt.inventory === null
      ? null
      : { gold: hunt.inventory.gold, usedSlots: hunt.inventory.usedSlots, capacity: hunt.inventory.capacity };
  const fault = hunt.commandError ?? hunt.error;

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
          canStart={hunt.canStart}
          pending={hunt.pending}
          strategyName={strategyName}
          onStart={hunt.start}
          onStop={hunt.stop}
          onOpenStrategy={() => setStrategyOpen(true)}
        />
        {fault !== null && (
          <p className="hint" role="alert" data-testid="hunt-fault">
            {t(`serverError.${fault.code}`)}
          </p>
        )}
        {hunt.reportId !== null && (
          <p className="hint" role="status">
            {t('hunt.report')}
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
