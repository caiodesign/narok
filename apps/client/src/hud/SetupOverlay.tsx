/**
 * The laboratory's setup, presented over the world as the Strategy screen.
 *
 * `hunt.html` has no form anywhere — a hunt is configured on the Strategy
 * screen, and that screen is now ported: this is `strategy.html`'s `.editor`
 * dialog, opened over a scrim, with its head, its three columns and its panes.
 *
 * Dropped from the reference's chrome, because milestone A has nothing behind
 * them: the preset tabs and their premium fourth slot, Revert, Save preset and
 * Apply next encounter, and the dirty-draft markers. A setup edit here starts a
 * *new experiment* — there is no saved preset to be dirty against and no
 * running encounter to queue a change for. Both of those are milestone B's
 * (UI spec section 5), and the apply-note says so in the operator's own words
 * rather than leaving the reference's sentence to describe machinery that does
 * not exist.
 *
 * It is open while there is nothing running, because a laboratory with no
 * experiment loaded has nothing else worth looking at, and closes once a run
 * starts so the hunt is unobstructed.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Content } from '@narok/data';
import type { LabInput } from '@narok/sim';
import { ExperimentControls } from '../ExperimentControls';
import type { ExperimentStatus } from '../useExperiment';

export interface SetupOverlayProps {
  open: boolean;
  content: Content;
  status: ExperimentStatus;
  onStart: (input: LabInput) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSpeedChange: (speed: number) => void;
  onDraftChange: (draft: LabInput, canStart: boolean) => void;
  onClose: () => void;
}

/*
 * The only geometry this file states. `.editor` already centres itself and sizes
 * itself against the viewport, and `.scrim` already covers it; all that is left
 * is to lift both above the world they cover.
 */
const LAYER: React.CSSProperties = { zIndex: 5 };

/**
 * The form is hidden rather than unmounted, and memoised because of it: while a
 * run plays, every published frame would otherwise reconcile the whole setup
 * form — the placement grid, the roster and the per-actor strategy editors —
 * for a subtree nobody can see. Every prop it takes is either `content` or a
 * stable `useCallback`, so the memo bails out immediately.
 *
 * The form is hidden rather than unmounted. `ExperimentControls` holds the
 * draft, the selected character and the focused cell in local state, so
 * unmounting it on start and remounting it on stop threw away the operator's
 * whole setup and reset it to `defaultDraft` — which defeats the laboratory's
 * purpose, since a second run is normally a tweak of the first.
 */
export const SetupOverlay = memo(function SetupOverlay(props: SetupOverlayProps): React.JSX.Element {
  const { open, onClose, ...controls } = props;
  const { t } = useTranslation();

  return (
    <>
      <div className="scrim" style={LAYER} hidden={!open} aria-hidden="true" />
      <section
      className="editor win"
      style={LAYER}
      hidden={!open}
      role="dialog"
      aria-modal="false"
      aria-labelledby="editor-title"
    >
      <header className="editor-head">
        <h2 className="win-title" id="editor-title">
          {t('controls.section')}
          <small>{t('controls.editorSubtitle')}</small>
          <button type="button" className="win-close preset-edit" onClick={onClose}>
            {t('controls.closeSetup')}
          </button>
        </h2>
      </header>
      <p className="apply-note" role="status">
        {t('controls.applyNote')}
      </p>
      {/* The transport lives in the Orders window; two copies would give the
          page two controls sharing one accessible name. */}
      <ExperimentControls {...controls} showRunControls={false} />
      </section>
    </>
  );
});
