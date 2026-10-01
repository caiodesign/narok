/**
 * The Strategy screen with its preset lifecycle (milestone B spec part 4
 * §3.2; UI spec §5; gate B-10) — `codex-examples/realm-refined/strategy.html`'s
 * `.editor` dialog, head, `.preset-bar` and `.apply-note`, around the same
 * three panes the laboratory's setup uses (`ExperimentControls`,
 * `variant="preset"`).
 *
 * `docs/realm-strategy-port.md` deferred the preset tabs, Revert, Save preset,
 * Apply next encounter and the unsaved markers to milestone B; this builds
 * them, one row of part 4 §3.2's table each:
 *
 *  - **Edit** mutates the draft only, issues no command, and marks the tab,
 *    the character and the bar unsaved.
 *  - **Save preset** sends the payload and clears the marker when the server
 *    acknowledges the new version — not on click.
 *  - **Apply next encounter** saves a dirty draft first, then queues *that
 *    exact version*; it reads as pending until the server reports it active.
 *    Active and pending are the server's (`GET /api/hunts/current`), rendered
 *    separately, and the queue holds a version, never a reference: saving the
 *    preset again later leaves the pending version as it was.
 *  - **Revert** restores the last saved preset. Local; no command.
 *  - **Close** with unsaved changes offers Keep editing / Discard / Save; a
 *    draft is never silently lost. Switching tabs loses nothing either: each
 *    preset keeps its own draft until it is saved, reverted or discarded.
 *
 * A refusal is rendered from the server's stable code (`serverError.<CODE>`),
 * and `CONFLICT_STATE_VERSION` as a recoverable conflict: the draft stays, and
 * Save or Apply can simply be pressed again.
 *
 * Three preset tabs, never four: the reference's locked premium slot is
 * forbidden outright (part 4 §3.2, spec §2.2). R111, R112 and R113 bind the
 * panes unchanged — the board is derived from `content.grid`, its SVG stays
 * `aria-hidden` scenery over a `role="grid"` of buttons, and no rule inside
 * `strategy.css` is edited; the only geometry stated here is the layer.
 *
 * Ruling R174: each preset tab keeps its own draft until it is saved, reverted
 * or discarded; a save's acknowledged version is this screen's baseline until
 * the preset list is re-read; and Apply next encounter is disabled while no
 * hunt is running — because the table forbids silently losing a draft (and a
 * tab switch is as silent as a close), the marker must clear on the server's
 * acknowledgement whether or not the list has been re-read yet, and there is
 * no next encounter to queue a version for without a hunt.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClassId, Content } from '@narok/data';
import type { ExperimentStatus } from '../../status';
import { ExperimentControls, type EditorDraft } from '../../ExperimentControls';
import { faultOf, type PresetRef, type StrategyPresetRecord } from '../../commands';
import type { ProtocolFault } from '../../protocol';
import type { StrategyCommands } from '../../useHunt';
import { draftFromPreset, payloadOf, PRESET_TAB_LIMIT, samePayload, unsavedActorsOf } from './presets';

export interface StrategyScreenProps {
  open: boolean;
  content: Content;
  /** The account's saved strategy presets (`GET /api/presets`). */
  presets: readonly StrategyPresetRecord[];
  /** The party the presets are drafted for: the account's characters' classes, in slot order. */
  classes: readonly ClassId[];
  selectedPresetId: string | null;
  onSelectPreset: (presetId: string) => void;
  /** The version the running hunt uses, as the server reports it. */
  active: PresetRef | null;
  /** The version queued for the next encounter, as the server reports it. */
  pending: PresetRef | null;
  status: ExperimentStatus;
  commands: StrategyCommands;
  onClose: () => void;
}

type Busy = 'save' | 'apply' | 'close' | null;
type Notice = 'applyNote' | 'savedNote' | 'queuedNote' | 'revertedNote';

/** A version the server acknowledged before the preset list was re-read. */
interface Baseline {
  readonly draft: EditorDraft;
  readonly version: number;
}

const LAYER: React.CSSProperties = { zIndex: 5 };
/** The tab panel is semantics only: `.editor-body` must stay the `.editor` column's flex child. */
const PANEL: React.CSSProperties = { display: 'contents' };

export function StrategyScreen({
  open,
  content,
  presets,
  classes,
  selectedPresetId,
  onSelectPreset,
  active,
  pending,
  status,
  commands,
  onClose,
}: StrategyScreenProps): React.JSX.Element {
  const { t } = useTranslation();

  const tabs = useMemo(() => presets.slice(0, PRESET_TAB_LIMIT), [presets]);
  const selected = tabs.find((preset) => preset.id === selectedPresetId) ?? tabs[0] ?? null;

  const [drafts, setDrafts] = useState<Readonly<Record<string, EditorDraft>>>({});
  const [baselines, setBaselines] = useState<Readonly<Record<string, Baseline>>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [fault, setFault] = useState<ProtocolFault | null>(null);
  const [notice, setNotice] = useState<{ key: Notice; name?: string; version?: number }>({ key: 'applyNote' });
  const [prompt, setPrompt] = useState(false);

  /** The last saved version of a preset: the newest of the server's list and this screen's acknowledgements. */
  const savedOf = useCallback(
    (record: StrategyPresetRecord): Baseline => {
      const acknowledged = baselines[record.id];
      if (acknowledged !== undefined && acknowledged.version > record.presetVersion) return acknowledged;
      return { draft: draftFromPreset(record, classes), version: record.presetVersion };
    },
    [baselines, classes],
  );

  const isDirty = useCallback(
    (record: StrategyPresetRecord): boolean => {
      const draft = drafts[record.id];
      return draft !== undefined && !samePayload(draft, savedOf(record).draft);
    },
    [drafts, savedOf],
  );

  const saved = selected === null ? null : savedOf(selected);
  const draft = selected === null ? null : (drafts[selected.id] ?? saved!.draft);
  const dirty = selected !== null && isDirty(selected);
  const unsavedActors = useMemo(
    () => (draft !== null && saved !== null && dirty ? unsavedActorsOf(draft, saved.draft) : new Set<string>()),
    [draft, saved, dirty],
  );

  const onDraftEdit = useCallback(
    (next: EditorDraft) => {
      if (selected === null) return;
      setDrafts((current) => ({ ...current, [selected.id]: next }));
      setNotice({ key: 'applyNote' });
    },
    [selected],
  );

  const nameOf = (ref: PresetRef): string => presets.find((preset) => preset.id === ref.presetId)?.name ?? ref.presetId;

  /** Saves one preset's draft; resolves with the acknowledged version. */
  const saveDraft = async (record: StrategyPresetRecord, edited: EditorDraft): Promise<PresetRef> => {
    const ref = await commands.save(record.id, payloadOf(edited));
    // The marker clears here, on the server's acknowledgement.
    setBaselines((current) => ({ ...current, [record.id]: { draft: edited, version: ref.presetVersion } }));
    return ref;
  };

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>): Promise<boolean> => {
    if (busy !== null) return false;
    setBusy(kind);
    setFault(null);
    try {
      await action();
      return true;
    } catch (error) {
      setFault(faultOf(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const onSave = () => {
    if (selected === null || draft === null) return;
    void run('save', async () => {
      const ref = await saveDraft(selected, draft);
      setNotice({ key: 'savedNote', name: selected.name, version: ref.presetVersion });
    });
  };

  const onApply = () => {
    if (selected === null || draft === null || saved === null) return;
    void run('apply', async () => {
      // Save and queue *that exact version* (UI spec §5): a clean draft is the saved version already.
      const ref = dirty ? await saveDraft(selected, draft) : { presetId: selected.id, presetVersion: saved.version };
      await commands.apply(ref);
      setNotice({ key: 'queuedNote', name: selected.name, version: ref.presetVersion });
    });
  };

  const onRevert = () => {
    if (selected === null) return;
    setDrafts((current) => {
      const rest = { ...current };
      delete rest[selected.id];
      return rest;
    });
    setFault(null);
    setNotice({ key: 'revertedNote' });
  };

  const dirtyRecords = tabs.filter(isDirty);

  const requestClose = () => {
    if (dirtyRecords.length > 0) setPrompt(true);
    else onClose();
  };

  const onDiscard = () => {
    setDrafts({});
    setPrompt(false);
    setFault(null);
    setNotice({ key: 'applyNote' });
    onClose();
  };

  const onSaveAndClose = () => {
    void (async () => {
      const ok = await run('close', async () => {
        for (const record of dirtyRecords) await saveDraft(record, drafts[record.id]!);
      });
      setPrompt(false);
      if (ok) onClose();
    })();
  };

  const running = status === 'running';
  const noticeText = t(`strategy.${notice.key}`, { name: notice.name, version: notice.version });

  return (
    <>
      <div className="scrim" style={LAYER} hidden={!open} aria-hidden="true" />
      <section
        className="editor win"
        style={LAYER}
        hidden={!open}
        role="dialog"
        aria-modal="false"
        aria-labelledby="strategy-title"
        data-testid="strategy-screen"
      >
        <header className="editor-head">
          <h2 className="win-title" id="strategy-title">
            {t('strategy.title')} <small>{t('strategy.subtitle')}</small>
          </h2>
          <div className="head-tools">
            {running && (
              <p className="hunt-state">
                <i>
                  <svg aria-hidden="true">
                    <use href="#i-swords" />
                  </svg>
                </i>
                {t('strategy.huntRunning')}
              </p>
            )}
            <button className="close" type="button" aria-label={t('strategy.close')} onClick={requestClose}>
              <svg aria-hidden="true">
                <use href="#i-close" />
              </svg>
            </button>
          </div>
        </header>

        <div className="preset-bar">
          <div className="tabs" role="tablist" aria-label={t('strategy.presets')}>
            {tabs.map((preset, index) => {
              const isSelected = preset.id === selected?.id;
              return (
                <button
                  key={preset.id}
                  className="tab"
                  type="button"
                  role="tab"
                  id={`preset-tab-${preset.id}`}
                  aria-selected={isSelected}
                  aria-controls="preset-panel"
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => onSelectPreset(preset.id)}
                >
                  <span className="tab-order num">{index + 1}</span>
                  {preset.name}
                  {isDirty(preset) && <span className="unsaved" role="img" aria-label={t('strategy.unsaved')} />}
                </button>
              );
            })}
          </div>
          <div className="preset-actions">
            {selected !== null && saved !== null && (
              <p className="dirty-note" data-testid="dirty-note">
                {dirty ? (
                  <>
                    <span className="unsaved" aria-hidden="true" />
                    {t('strategy.unsavedDraft')}
                  </>
                ) : (
                  t('strategy.saved', { version: saved.version })
                )}
              </p>
            )}
            <button className="btn" type="button" disabled={!dirty || busy !== null} onClick={onRevert}>
              <svg aria-hidden="true">
                <use href="#i-revert" />
              </svg>
              {t('strategy.revert')}
            </button>
            <button
              className="btn"
              type="button"
              disabled={!dirty || busy !== null}
              aria-busy={busy === 'save'}
              onClick={onSave}
            >
              {busy === 'save' ? t('strategy.saving') : t('strategy.save')}
            </button>
            <button
              className="btn btn--save"
              type="button"
              disabled={selected === null || !running || busy !== null}
              aria-busy={busy === 'apply'}
              onClick={onApply}
            >
              <svg aria-hidden="true">
                <use href="#i-seal" />
              </svg>
              {busy === 'apply' ? t('strategy.applying') : t('strategy.apply')}
            </button>
          </div>
        </div>

        <p className="apply-note" role="status" data-testid="apply-status">
          {selected === null ? t('strategy.noPresets') : running ? noticeText : `${noticeText} ${t('strategy.noHunt')}`}
        </p>
        {(active !== null || pending !== null) && (
          <p className="apply-note">
            {active !== null && (
              <span data-testid="strategy-active">
                {t('strategy.active', { name: nameOf(active), version: active.presetVersion })}
              </span>
            )}
            {active !== null && pending !== null && ' · '}
            {pending !== null && (
              <span data-testid="strategy-pending">
                {t('strategy.pending', { name: nameOf(pending), version: pending.presetVersion })}
              </span>
            )}
          </p>
        )}
        {fault !== null && (
          <p className="apply-note" role="alert" data-testid="strategy-fault">
            {t(`serverError.${fault.code}`)}
            {fault.code === 'CONFLICT_STATE_VERSION' && ` ${t('strategy.conflictHelp')}`}
          </p>
        )}
        {prompt && (
          <div className="apply-note" role="alertdialog" aria-labelledby="close-prompt">
            <span id="close-prompt">{t('strategy.closePrompt')}</span>{' '}
            <button className="btn" type="button" onClick={() => setPrompt(false)}>
              {t('strategy.keepEditing')}
            </button>{' '}
            <button className="btn" type="button" disabled={busy !== null} onClick={onDiscard}>
              {t('strategy.discard')}
            </button>{' '}
            <button className="btn btn--save" type="button" disabled={busy !== null} onClick={onSaveAndClose}>
              {busy === 'close' ? t('strategy.saving') : t('strategy.save')}
            </button>
          </div>
        )}

        {selected !== null && draft !== null && (
          <div
            role="tabpanel"
            id="preset-panel"
            aria-labelledby={`preset-tab-${selected.id}`}
            style={PANEL}
          >
            <ExperimentControls
              key={selected.id}
              content={content}
              variant="preset"
              draft={draft}
              onDraftEdit={onDraftEdit}
              unsavedActors={unsavedActors}
              showRunControls={false}
            />
          </div>
        )}
      </section>
    </>
  );
}
