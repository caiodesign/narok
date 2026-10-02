/**
 * The Away report (milestone B Task 10; part 4 §3.5; UI spec §8; B-17).
 *
 * `codex-examples/realm-refined/away.html` is the shape: a report window over
 * the hushed world — the herald with time away and the simulated time against
 * the offline limit, the verdict with its counts, the party's results, the
 * totals and loot panes with the notable drops, the timeline, and the
 * actions. Its stylesheet is `away.css`, mounted only while this screen is
 * (R181).
 *
 * The whole screen is a read of progress the server already settled and
 * credited: it holds no command that grants anything, and opening, reopening
 * or refreshing it credits nothing. Its actions navigate; the order of the
 * first two is recomputed from the *current* inventory (`awayView`), so the
 * report stops asking for room once room exists. The actions sit in the
 * report's footer, outside the scrolling body, so neither a notable find nor
 * the timeline can cover the recovery action (part 4 §3.5 Never).
 *
 * Every figure is the report's own (R182). Report version 3 (Task 10 fix
 * round 1) carries what part 4 §3.5 must show and version 2 left out — R184's
 * waiver is withdrawn: the three counts (wipes this hunt, wipes this absence,
 * member deaths over the absence) side by side; each member's level and EXP
 * before and after with its deaths and revives; encounters won and lost; the
 * notable kept equipment (R193); and the bounded timeline (R191), drawn on the
 * reference's track from the moment the player left to the moment they came
 * back. A version-2 report shows none of these (R194). There is no wipe limit
 * to draw pips against: a full wipe ends the hunt (R154).
 */
import { useTranslation } from 'react-i18next';
import type { Content } from '@narok/data';
import sheet from '../away.css?raw';
import type { AwayAction, AwayReportRecord, AwayTimelineRecord, CharacterSummary, InventoryResponse } from '../commands';
import { classGlyphId, classNames, medalModifier } from '../hud/model';
import { SpriteSheet } from '../hud/SpriteSheet';
import { WorldBackdrop } from '../hud/WorldBackdrop';
import { formatDuration, formatNumber } from '../i18n';
import { definitionIconById, rarityRow } from './icons';
import { awayView, markSide, shareOf } from './model';
import { useRouteSheet } from './sheets';
import { TownSprites } from './TownSprites';

export interface AwayReportProps {
  readonly report: AwayReportRecord;
  readonly content: Content;
  /** The roster, to name the report's members. */
  readonly characters: readonly CharacterSummary[];
  readonly inventory: InventoryResponse | null;
  readonly lootPresetName: string | null;
  readonly onManageBag: () => void;
  readonly onReturnToHunt: () => void;
  readonly onStartHunt: () => void;
  readonly onReviewFilter: () => void;
}

/** The reference's mark classes, by what the entry records. */
const MARK: Record<AwayTimelineRecord['kind'], string> = {
  won: 'mark--level',
  wipe: 'mark--death',
  death: 'mark--death',
  revive: 'mark--epic',
  'drop-lost': 'mark--lost',
  stop: 'mark--stop',
  cap: 'mark--end',
};

export function AwayReport(props: AwayReportProps): React.JSX.Element {
  useRouteSheet('away', sheet);
  const { report, content, characters, inventory, lootPresetName } = props;
  const { t, i18n } = useTranslation();
  const number = (value: number) => formatNumber(value, i18n.language);
  const duration = (ms: number) => formatDuration(ms, t, i18n.language);
  const view = awayView(report, inventory);
  const { outcomes } = report;
  const consumed = Object.entries(outcomes.consumed).filter(([, units]) => units > 0);
  const sinceLeft = (atWallMs: number) => atWallMs - report.awayFromWall;
  const at = (atWallMs: number) => `${shareOf(sinceLeft(atWallMs), report.timeAwayMs)}%`;

  // A member is named from the roster; one no longer in it, by its class.
  const nameOf = (characterId: string | null): string => {
    const member = characters.find((entry) => entry.id === characterId);
    if (member !== undefined) return member.name;
    const result = report.party?.find((entry) => entry.characterId === characterId);
    return result === undefined ? t('away.timeline.member') : t(`class.${result.classId}`);
  };

  const entryLabel = (entry: AwayTimelineRecord): string => {
    switch (entry.kind) {
      case 'won':
        return t('away.timeline.won', { count: entry.count });
      case 'wipe':
        return t('away.timeline.wipe');
      case 'death':
        return t('away.timeline.death', { name: nameOf(entry.characterId) });
      case 'revive':
        return entry.reason === null || entry.reason === 'revive'
          ? t('away.timeline.revived', { name: nameOf(entry.characterId) })
          : t('away.timeline.apple', { name: nameOf(entry.characterId), item: t(`consumable.${entry.reason}`) });
      case 'drop-lost':
        return t('away.timeline.dropLost', { count: entry.count });
      case 'stop':
        return t('away.timeline.stop', { reason: t(`stopReason.${entry.reason ?? 'operator'}`) });
      case 'cap':
        return t('away.timeline.cap');
    }
  };

  const handlers: Record<AwayAction, () => void> = {
    'view-hunt': props.onReturnToHunt,
    'start-hunt': props.onStartHunt,
    'manage-bag': props.onManageBag,
  };

  const bagFilledAt = report.timeline?.find((entry) => entry.kind === 'drop-lost')?.atWallMs ?? null;

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
              {/* The report's own map, never whatever hunt runs when it is read (Minor 6). */}
              {report.mapId !== null && (
                <div className="fact fact--map">
                  <dt>{t('away.fact.map')}</dt>
                  <dd>{t(`map.${report.mapId}`)}</dd>
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
                {report.memberDeaths !== null && (
                  <span className="attempts-note">{t('away.wipes.memberDeaths', { count: report.memberDeaths })}</span>
                )}
              </div>
            </div>

            {report.party !== null && report.party.length > 0 && (
              <section aria-labelledby="party-title">
                <h2 className="section-title" id="party-title">
                  {t('away.party.title')} <small>{t('away.party.outcomes', { won: outcomes.wins, lost: outcomes.wipes })}</small>
                </h2>
                <div className="party-results">
                  {report.party.map((member) => {
                    const up = member.levelAfter > member.levelBefore;
                    return (
                      <article className={classNames('unit win result', up && 'result--up')} key={member.characterId}>
                        <div className={classNames('medal', medalModifier(member.classId))}>
                          <svg aria-hidden="true">
                            <use href={`#${classGlyphId(member.classId)}`} />
                          </svg>
                          <span className="lvl num">{number(member.levelAfter)}</span>
                        </div>
                        <div>
                          <header className="unit-head">
                            <h3 className="unit-name">{nameOf(member.characterId)}</h3>
                            <span className="unit-class">{t(`class.${member.classId}`)}</span>
                            <span className="lvl-change">
                              {up ? (
                                <>
                                  <span className="levelup-flag">
                                    <svg aria-hidden="true">
                                      <use href="#i-star" />
                                    </svg>
                                    {t('away.party.levelUp')}
                                  </span>
                                  <span className="from num">{number(member.levelBefore)}</span>
                                  <span aria-label={t('away.party.to')}>→</span>
                                  <b className="num">{number(member.levelAfter)}</b>
                                </>
                              ) : (
                                t('away.party.level', { level: member.levelAfter })
                              )}
                            </span>
                          </header>
                        </div>
                        <dl className="result-stats">
                          <div className="exp">
                            <dt>{t('away.party.expLabel')}</dt>
                            <dd className="num">{t('away.party.exp', { from: number(member.expBefore), to: number(member.expAfter) })}</dd>
                          </div>
                          <div className="deaths">
                            <dt>{t('away.party.deaths')}</dt>
                            <dd className="num">
                              <svg aria-hidden="true">
                                <use href="#i-skull" />
                              </svg>
                              {number(member.deaths)}
                            </dd>
                          </div>
                          <div className="revives">
                            <dt>{t('away.party.revives')}</dt>
                            <dd className="num">{number(member.revives)}</dd>
                          </div>
                        </dl>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

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
                {report.notable !== null && report.notable.length > 0 && (
                  <ul className="notable" aria-label={t('away.notable.label')}>
                    {report.notable.map((drop) => (
                      <li className={classNames('drop', rarityRow(drop.rarity))} key={drop.rewardId}>
                        <span className="drop-icon">
                          <svg aria-hidden="true">
                            <use href={`#${definitionIconById(drop.definitionId, content)}`} />
                          </svg>
                        </span>
                        <span className="drop-name">{t(`item.${drop.definitionId}`)}</span>
                        <span className="drop-age">{duration(sinceLeft(drop.atWallMs))}</span>
                        <span className="drop-note">
                          {t('away.notable.note', { rarity: t(`rarity.${drop.rarity}`), count: drop.bonusCount, level: number(drop.itemLevel) })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {report.notable !== null && report.notableTotal !== null && report.notableTotal > report.notable.length && (
                  <p className="drop-note">{t('away.notable.more', { count: report.notableTotal - report.notable.length })}</p>
                )}
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

            {report.timeline !== null && (
              <section className="chronicle win" aria-labelledby="chron-title">
                <h2 className="section-title" id="chron-title">
                  {t('away.timeline.title')}{' '}
                  {report.timelineOmitted !== null && report.timelineOmitted > 0 && (
                    <small>{t('away.timeline.omitted', { count: report.timelineOmitted })}</small>
                  )}
                </h2>
                <div className="track-wrap">
                  {/* The track is the absence; past the first lost drop it is hatched, as the reference draws a full bag. */}
                  <div className="track" aria-hidden="true">
                    <span className="track-looting" style={{ width: `calc(${bagFilledAt === null ? '100%' : at(bagFilledAt)} - 4px)` }} />
                    {bagFilledAt !== null && <span className="track-dry" style={{ left: at(bagFilledAt) }} />}
                  </div>
                  <ol aria-label={t('away.timeline.label')}>
                    {report.timeline.map((entry, index) => (
                      <li
                        className={classNames('mark', `mark--${markSide(index)}`, MARK[entry.kind])}
                        key={`${entry.kind}:${entry.atWallMs}:${index}`}
                        style={{ '--at': at(entry.atWallMs) } as React.CSSProperties}
                      >
                        <span className="mark-label">
                          <time>{duration(sinceLeft(entry.atWallMs))}</time>
                          {entryLabel(entry)}
                        </span>
                      </li>
                    ))}
                    <li
                      className={classNames('mark', `mark--${markSide(report.timeline.length)}`, 'mark--end')}
                      style={{ '--at': at(report.returnedAtWall) } as React.CSSProperties}
                    >
                      <span className="mark-label">
                        <time>{duration(report.timeAwayMs)}</time>
                        {t('away.timeline.returned')}
                      </span>
                    </li>
                  </ol>
                </div>
              </section>
            )}
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
                  ? t('away.note.full', { used: number(inventory.usedSlots), capacity: number(inventory.capacity), count: outcomes.drops.lost })
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
