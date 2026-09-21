/**
 * The laboratory's setup form, presented over the world.
 *
 * `hunt.html` has no form anywhere — a hunt is configured on the Strategy screen,
 * which milestone A does not build. The reference's `.orders` window is the
 * closest concept (what the hunt is told to do), so the Orders panel opens this,
 * and this renders `ExperimentControls` inside the reference's own `.win` window
 * chrome. No new visual treatment is introduced: only the overlay's placement is
 * expressed here, filling the band between the party column and the rail so both
 * stay readable while the setup is open.
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

const SHELL: React.CSSProperties = {
  position: 'absolute',
  top: 'var(--gutter)',
  left: 'calc(var(--gutter) * 2 + var(--party-w))',
  right: 'calc(var(--gutter) * 2 + var(--rail-w))',
  bottom: '24px',
  overflowY: 'auto',
  zIndex: 5,
};

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
    <section className="win" style={SHELL} hidden={!open} aria-label={t('controls.section')}>
      <h2 className="win-title">
        {t('controls.section')}
        <button type="button" className="win-close preset-edit" onClick={onClose}>
          {t('controls.closeSetup')}
        </button>
      </h2>
      {/* The transport lives in the Orders window; two copies would give the
          page two controls sharing one accessible name. */}
      <ExperimentControls {...controls} showRunControls={false} />
    </section>
  );
});
