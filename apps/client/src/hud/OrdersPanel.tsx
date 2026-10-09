/**
 * The rail's orders window — `codex-examples/realm-refined/hunt.html:1370-1384`.
 *
 * "Orders" in the reference is what the hunt has been told to do: its strategy
 * preset, and the one sealed action that is next. In the game client that
 * action is a command to the server, never a local clock operation, so this
 * window carries exactly two run controls (owner's Stop decision, ruling R166):
 *
 *  - **Start hunt** — `POST /api/hunts`;
 *  - **Stop** — `POST /api/hunts/current/stop`: the party returns to town and
 *    the current encounter is abandoned. There is no resume. Once the hunt is
 *    stopped this second control **starts a new hunt**, and the helper copy
 *    says why it stopped (ruling R177): after the owner's Stop, that the
 *    encounter was abandoned and the return took travel time; after a wipe,
 *    that the party fell and the town healed it fully. No copy names a respawn
 *    or a wipe limit — neither exists (owner decision 2026-09-30).
 *
 * Each control shows *pending* until the server answers, and is disabled
 * meanwhile: the client never presents a command as done before it is
 * acknowledged (part 4 §3.1). There is no Pause and no Resume here or anywhere
 * on the hunt path; the laboratory's pausable clock has its own panel in
 * `apps/lab`. There is no speed control either: production playback speed is
 * an open decision (part 4 §2), and the hunt plays at 1×.
 *
 * Both controls are always in the document, each enabled exactly while its
 * action is legal, so their names stay reachable by `getByRole`. A faulted hunt
 * offers no normal Start (part 4 §2): it needs an explicit recovery.
 *
 * After a Stop the party travels home for the content's return journey, and
 * the server refuses a start until it is in town (`hunt.travel`). Meanwhile
 * Start a new hunt keeps its name but is disabled, and a note it is described
 * by says the party is returning and when it arrives — so the refusal is never
 * the first the player hears of the journey.
 *
 * Ruling R177: the stopped helper is chosen by the wire's `stopReason`, one
 * localised key per reason the protocol defines plus `unknown` for a stopped
 * state that carries none, and only `operator` says "abandoned" — because
 * part 4 §3.1 requires the stopped state "with its actual reason", and a wipe
 * or a stalemate did not abandon anything.
 *
 * Ruling R166 (milestone B Task 9; the plan's R132): Stop is a command that
 * returns the party to town and abandons the encounter, there is no resume,
 * and once stopped the second control starts a new hunt whose copy says the
 * encounter was abandoned and the return took travel time; no client path
 * pauses authoritative time, and the Pause and Resume affordances and their
 * locale keys leave the hunt path for `apps/lab` — because the owner decided
 * Stop that way (index §4.0), and a pause on a server-owned clock would be the
 * client asserting time (part 4 §1).
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExperimentStatus } from '../status';
import type { StopReason } from '../useHunt';

export type OrdersPending = 'start' | 'stop' | null;

export interface OrdersPanelProps {
  status: ExperimentStatus;
  /** Why a stopped hunt stopped; `null` when it runs or the reason is unknown. */
  stopReason?: StopReason | null;
  /** The hunt is faulted: no normal Start (part 4 §2). */
  faulted?: boolean;
  canStart: boolean;
  /** Milliseconds until a stopped party reaches town; `0` once it is there. */
  returningMs?: number;
  pending: OrdersPending;
  /**
   * The strategy by its saved name: the active one while a hunt runs, the one a
   * start would run otherwise; `null` when there is none.
   */
  strategyName: string | null;
  onStart: () => void;
  onStop: () => void;
  onOpenStrategy: () => void;
  /**
   * The town screens (milestone B Task 10): the reference's second preset
   * button opens the Bag and loot filter, named by the loot preset the hunt
   * runs; the party button opens Character. Omitted, neither is drawn.
   */
  lootFilterName?: string | null;
  onOpenBag?: () => void;
  onOpenCharacter?: () => void;
  /** The party's names, for the Character button. */
  partyLabel?: string | null;
}

interface Control {
  readonly key: 'start' | 'stop';
  readonly label: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onClick: () => void;
  readonly describedBy?: string;
}

function SealedButton({ control }: { control: Control }): React.JSX.Element {
  return (
    <button
      className="stop"
      type="button"
      disabled={control.disabled}
      aria-busy={control.busy}
      aria-describedby={control.describedBy}
      onClick={control.onClick}
    >
      <span className="stop-seal" aria-hidden="true">
        <i />
      </span>
      {control.label}
    </button>
  );
}

export function OrdersPanel({
  status,
  stopReason = null,
  faulted = false,
  canStart,
  returningMs = 0,
  pending,
  strategyName,
  onStart,
  onStop,
  onOpenStrategy,
  lootFilterName = null,
  onOpenBag,
  onOpenCharacter,
  partyLabel = null,
}: OrdersPanelProps): React.JSX.Element {
  const { t } = useTranslation();

  const running = status === 'running';
  const stopped = status === 'stopped';
  const waiting = pending !== null;
  const returning = stopped && !faulted && returningMs > 0;
  const travelId = useId();

  const first: Control = {
    key: 'start',
    label: pending === 'start' && !stopped ? t('hunt.startPending') : t('hunt.start'),
    disabled: faulted || waiting || running || stopped || !canStart,
    busy: pending === 'start' && !stopped,
    onClick: onStart,
  };

  // The second control: Stop while a hunt runs, and the way to a new hunt once it has stopped.
  const second: Control = stopped
    ? {
        key: 'start',
        label: pending === 'start' ? t('hunt.startPending') : t('hunt.newHunt'),
        disabled: faulted || waiting || returning || !canStart,
        busy: pending === 'start',
        onClick: onStart,
        describedBy: returning ? travelId : undefined,
      }
    : {
        key: 'stop',
        label: pending === 'stop' ? t('hunt.stopPending') : t('hunt.stop'),
        disabled: waiting || !running,
        busy: pending === 'stop',
        onClick: onStop,
      };

  // The reference seals the one action that is next; the other stays compact.
  const sealed = running || stopped ? second : first;
  const compact = sealed === first ? second : first;

  const help = faulted
    ? t('hunt.faultedHelp')
    : running
      ? t('hunt.runningHelp')
      : returning
        ? t('hunt.returningHelp')
        : stopped
          ? t(`hunt.stoppedHelp.${stopReason ?? 'unknown'}`)
        : canStart || waiting
          ? t('hunt.idleHelp')
          : t('hunt.unavailable');

  return (
    <section className="orders win" aria-label={t('hunt.orders')}>
      <button className="preset" type="button" onClick={onOpenStrategy}>
        <span className="preset-kind">{t('hunt.strategy')}</span>
        <span className="preset-value">{strategyName ?? t('strategy.noPresets')}</span>
        <span className="preset-edit">
          <svg aria-hidden="true">
            <use href="#i-quill" />
          </svg>
          {t('hunt.openStrategy')}
        </span>
      </button>

      {onOpenBag !== undefined && (
        <button className="preset" type="button" onClick={onOpenBag}>
          <span className="preset-kind">{t('hunt.lootFilter')}</span>
          <span className="preset-value">{lootFilterName ?? t('hunt.openBag')}</span>
          <span className="preset-edit">
            <svg aria-hidden="true">
              <use href="#i-quill" />
            </svg>
            {t('hunt.openBag')}
          </span>
        </button>
      )}
      {onOpenCharacter !== undefined && (
        <button className="preset" type="button" onClick={onOpenCharacter}>
          <span className="preset-kind">{t('hunt.party')}</span>
          <span className="preset-value">{partyLabel ?? t('hunt.party')}</span>
          <span className="preset-edit">
            <svg aria-hidden="true">
              <use href="#i-quill" />
            </svg>
            {t('hunt.openCharacter')}
          </span>
        </button>
      )}

      <SealedButton control={sealed} />

      <div className="run-actions">
        <button
          className="preset-edit"
          type="button"
          disabled={compact.disabled}
          aria-busy={compact.busy}
          onClick={compact.onClick}
        >
          {compact.label}
        </button>
      </div>

      <p className="hint" data-testid="orders-help">
        {help}
      </p>
      {returning && (
        <p className="hint travel" id={travelId} data-testid="orders-travel">
          {t('hunt.returning', { seconds: Math.ceil(returningMs / 1000) })}
        </p>
      )}
    </section>
  );
}
