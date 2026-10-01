/**
 * The Realm HUD's chat window (`codex-examples/realm-refined/hunt.html:1387-1408`).
 *
 * The reference's chat is a `.chat win` box holding a tab strip, a masked log and a
 * painted scroll thumb. All of that behaviour — the two tabs, the 500-row bound, the
 * roving tabindex, the live region and the return-to-latest control (R61/R82) — is
 * `EventLog`, which now emits the reference's own `.tabs`/`.tab`/`.log-wrap`/`.log`/
 * `.scroll` chrome. This component is only the window around it, so the panel and
 * the log cannot drift apart.
 *
 * The reference shows three tabs, and so does this window again: milestone A had
 * no loot event and left the Loot tab out (R108); milestone B's server publishes
 * one, so the tab returns *bound* to it (part 4 §3.1) — it lists the loot events
 * the socket released and nothing invented.
 */
import { useTranslation } from 'react-i18next';
import type { DomainEvent, PublicActor } from '@narok/sim';
import { EventLog } from '../EventLog';

export interface ChatPanelProps {
  events: readonly DomainEvent[];
  actors: readonly PublicActor[];
}

export function ChatPanel(props: ChatPanelProps): React.JSX.Element {
  const { events, actors } = props;
  const { t } = useTranslation();

  return (
    <section className="chat win" aria-label={t('app.log')}>
      <EventLog events={events} actors={actors} />
    </section>
  );
}
