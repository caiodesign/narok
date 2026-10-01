/**
 * The Realm HUD, engine-free (milestone B Task 8, gate B-02).
 *
 * `codex-examples/realm-refined/hunt.html` is the approved design. Its stylesheet
 * is ported verbatim into `styles.css` and its regions are ported into
 * `src/hud/*`, so this file is only the composition: the `.realm` fixed viewport
 * and the regions the reference anchors inside it.
 *
 * The client runs no simulation. Milestone A's laboratory, which drove these
 * regions from a worker running `@narok/sim`, moved to `apps/lab` and composes
 * the same HUD from `@narok/client` (ruling R164: the lab may import the client,
 * the client never imports the lab). Until the server's hunt is wired in
 * (Task 9), there is no `PublicState` to show, so every region renders its
 * empty state — never a placeholder figure (R108).
 */
import { useTranslation } from 'react-i18next';
import { content } from '@narok/data';
import { Battlefield } from './hud/Battlefield';
import { ChatPanel } from './hud/ChatPanel';
import { CommandBar } from './hud/CommandBar';
import { Compass } from './hud/Compass';
import { PartyPanel } from './hud/PartyPanel';
import { SessionPanel } from './hud/SessionPanel';
import { SpriteSheet } from './hud/SpriteSheet';
import { TargetFrame } from './hud/TargetFrame';
import { WorldBackdrop } from './hud/WorldBackdrop';

const noop = (): void => undefined;
// Stable empty inputs, so no region's memo sees a new identity on a re-render.
const NO_EVENTS: never[] = [];

export function App(): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="realm">
      <SpriteSheet />
      <WorldBackdrop />
      <Battlefield state={null} grid={content.grid} events={NO_EVENTS} />

      <TargetFrame state={null} />

      <div className="leftcol">
        <PartyPanel state={null} selectedId={null} onSelect={noop} />
        <SessionPanel state={null} />
      </div>

      <aside className="rail" aria-label={t('app.session')}>
        <Compass state={null} grid={content.grid} status="idle" recipeId={null} />
      </aside>

      <ChatPanel events={NO_EVENTS} actors={NO_EVENTS} />

      <CommandBar state={null} selectedId={null} inspected={null} onInspect={noop} />
    </div>
  );
}
