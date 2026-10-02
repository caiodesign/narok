/**
 * The Away report (milestone B Task 10; part 4 §3.5; UI spec §8; B-17).
 *
 * `codex-examples/realm-refined/away.html` is the shape: a report window over
 * the hushed world — the herald with time away and the simulated time against
 * the offline limit, the verdict, the totals and loot panes, and the actions.
 * Its stylesheet is `away.css`, mounted only while this screen is (R181).
 *
 * The whole screen is a read of progress the server already settled and
 * credited: it holds no command that grants anything, and opening, reopening
 * or refreshing it credits nothing. Its actions navigate; the order of the
 * first two is recomputed from the *current* inventory (`awayView`), so the
 * report stops asking for room once room exists.
 *
 * Ruling R184: the screen shows the report's two wipe counts — this hunt's
 * and this absence's — and leaves out per-member deaths, per-member results,
 * notable drops, the time split and the timeline, because the report carries
 * none of them and inventing one is what R182 forbids. There is no wipe limit to draw
 * pips against: a full wipe ends the hunt (R154).
 */
import { useTranslation } from 'react-i18next';
import sheet from '../away.css?raw';
import type { AwayAction, AwayReportRecord, InventoryResponse } from '../commands';
import { classNames } from '../hud/model';
import { SpriteSheet } from '../hud/SpriteSheet';
import { WorldBackdrop } from '../hud/WorldBackdrop';
import { formatDuration, formatNumber } from '../i18n';
import { awayView, shareOf } from './model';
import { useRouteSheet } from './sheets';
import { TownSprites } from './TownSprites';

export interface AwayReportProps {
  readonly report: AwayReportRecord;
  readonly inventory: InventoryResponse | null;
  readonly lootPresetName: string | null;
  readonly zone: string | null;
  readonly onManageBag: () => void;
  readonly onReturnToHunt: () => void;
  readonly onStartHunt: () => void;
  readonly onReviewFilter: () => void;
}

export function AwayReport(props: AwayReportProps): React.JSX.Element {
  useRouteSheet('away', sheet);
  const { report, inventory, lootPresetName, zone } = props;
  const { t, i18n } = useTranslation();
  const number = (value: number) => formatNumber(value, i18n.language);
  const duration = (ms: number) => formatDuration(ms, t, i18n.language);
  const view = awayView(report, inventory);
  const { outcomes } = report;
  const consumed = Object.entries(outcomes.consumed).filter(([, units]) => units > 0);

  const handlers: Record<AwayAction, () => void> = {
    'view-hunt': props.onReturnToHunt,
    'start-hunt': props.onStartHunt,
    'manage-bag': props.onManageBag,
  };

  return (
    <div className="realm">
      <SpriteSheet />
      <TownSprites />
      <WorldBackdrop />
      <div className="hush" aria-hidden="true" />

      <div className="dialog-stage">
        <section className="report win" aria-labelledby="report-title" aria-describedby="report-verdict">
          <header className="herald">
            <div className="herald-crest">
              <svg className="sigil" aria-hidden="true">
                <use href="#i-sunrise" />
              </svg>
              <div>
                <h1 className="herald-title" id="report-title">
                  {t('away.title')}
                </h1>
                <p className="herald-sub">
                  <b className="num">{duration(view.timeAwayMs)}</b> {t('away.credited')}
                </p>
              </div>
            </div>
            <dl className="herald-facts">
              <div className="fact fact--away">
                <dt>{t('away.fact.away')}</dt>
                <dd className="num">{duration(view.timeAwayMs)}</dd>
              </div>
              <div className="fact cap">
                <dt>{t('away.fact.simulated', { simulated: duration(view.simulatedMs), cap: duration(view.capMs) })}</dt>
                <dd>
                  <div
                    className="cap-track"
                    role="meter"
                    aria-label={t('away.capMeter')}
                    aria-valuenow={view.simulatedMs}
                    aria-valuemin={0}
                    aria-valuemax={view.capMs}
                  >
                    <i style={{ width: `calc(${shareOf(view.simulatedMs, view.capMs)}% - 2px)` }} />
                  </div>
                  <div className="cap-legend">
                    <span>{duration(0)}</span>
                    <span>{duration(view.capMs)}</span>
                  </div>
                </dd>
              </div>
              {zone !== null && (
                <div className="fact fact--map">
                  <dt>{t('away.fact.map')}</dt>
                  <dd>{t(`map.${zone}`)}</dd>
                </div>
              )}
            </dl>
          </header>

          <div className="report-body">
            <div className={classNames('verdict', view.isFailure && 'verdict--failure')} id="report-verdict">
              <span className="verdict-seal" aria-hidden="true">
                <svg>
                  <use href={view.status === 'bag-full' ? '#i-bag' : view.status === 'stopped' ? '#i-skull' : '#i-hourglass'} />
                </svg>
              </span>
              <div>
                <h2 className="verdict-head">{t(view.copyKey)}</h2>
                {outcomes.drops.lost > 0 && (
                  <p className="verdict-text">
                    {t('away.loot.lost', { count: outcomes.drops.lost })}. {t('away.loot.lostNote')}
                  </p>
                )}
              </div>
              <div className="attempts" aria-label={t('away.wipes.label')}>
                <span className="attempts-label">{t('away.wipes.thisHunt', { count: view.wipes.thisHunt })}</span>
                <span className="attempts-note">{t('away.wipes.thisAbsence', { count: view.wipes.thisAbsence })}</span>
              </div>
            </div>

            <div className="ledger-grid">
              <section className="pane win" aria-labelledby="totals-title">
                <h2 className="section-title" id="totals-title">
                  {t('away.totals')}
                </h2>
                <dl className="totals">
                  <div className="metric">
                    <dt>{t('away.kills')}</dt>
                    <dd>{number(outcomes.kills)}</dd>
                  </div>
                  <div className="metric">
                    <dt>{t('away.wins')}</dt>
                    <dd>{number(outcomes.wins)}</dd>
                  </div>
                  <div className="metric metric--exp">
                    <dt>{t('away.rawExp')}</dt>
                    <dd>+{number(outcomes.rawExp)}</dd>
                  </div>
                  <div className="metric metric--gold">
                    <dt>{t('away.rawGold')}</dt>
                    <dd>+{number(outcomes.rawGold)}</dd>
                  </div>
                  {consumed.length > 0 && (
                    <div className="metric">
                      <dt>{t('away.consumed')}</dt>
                      <dd>{number(consumed.reduce((sum, [, units]) => sum + units, 0))}</dd>
                      <table className="gold-split">
                        <caption className="sr-only">{t('away.consumed')}</caption>
                        <tbody>
                          {consumed.map(([id, units]) => (
                            <tr key={id}>
                              <th scope="row">{t(`consumable.${id}`)}</th>
                              <td>{number(units)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </dl>
              </section>

              <section className="pane win loot-pane" aria-labelledby="loot-title">
                <h2 className="section-title" id="loot-title">
                  {t('away.loot.title')} <small>{t('away.loot.rolled', { count: outcomes.drops.rolled })}</small>
                </h2>
                <dl className="totals">
                  <div className="metric">
                    <dt>{t('loot.action.keep')}</dt>
                    <dd>{t('away.loot.kept', { count: outcomes.drops.kept })}</dd>
                  </div>
                  <div className="metric">
                    <dt>{t('loot.action.ignore')}</dt>
                    <dd>{t('away.loot.ignored', { count: outcomes.drops.ignored })}</dd>
                  </div>
                </dl>
                {outcomes.drops.autoSold > 0 && (
                  <p className="sold-line">
                    <svg aria-hidden="true">
                      <use href="#i-coin" />
                    </svg>
                    <span>{t('away.loot.autoSold', { count: outcomes.drops.autoSold })}</span>
                  </p>
                )}
                {outcomes.drops.lost > 0 && (
                  <p className="sold-line">
                    <svg aria-hidden="true">
                      <use href="#i-bag" />
                    </svg>
                    <span>{t('away.loot.lost', { count: outcomes.drops.lost })}</span>
                  </p>
                )}
              </section>
            </div>
          </div>

          <footer className="actions">
            {view.primary !== null && (
              <button className="collect" type="button" onClick={handlers[view.primary]}>
                <span className="collect-seal" aria-hidden="true">
                  <svg>
                    <use href={view.primary === 'manage-bag' ? '#i-bag' : '#i-swords'} />
                  </svg>
                </span>
                {t(`away.action.${view.primary}`)}
              </button>
            )}
            {inventory !== null && (
              <p className="actions-note">
                {view.bagFullNow
                  ? t('away.note.full', { used: number(inventory.usedSlots), capacity: number(inventory.capacity), lost: number(outcomes.drops.lost) })
                  : t('away.note.room', { used: number(inventory.usedSlots), capacity: number(inventory.capacity) })}
              </p>
            )}
            {view.secondary.map((action) => (
              <button className="return-hunt" type="button" key={action} onClick={handlers[action]}>
                {t(`away.action.${action}`)}
              </button>
            ))}
            {lootPresetName !== null && (
              <button className="preset" type="button" onClick={props.onReviewFilter}>
                <span className="preset-kind">{t('away.filter')}</span>
                <span className="preset-value">{lootPresetName}</span>
                <span className="preset-edit">
                  <svg aria-hidden="true">
                    <use href="#i-quill" />
                  </svg>
                  {t('away.review')}
                </span>
              </button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}
