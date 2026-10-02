/**
 * The Character screen (milestone B Task 10; part 4 §3.4; UI spec §7).
 *
 * `codex-examples/realm-refined/character.html` is the shape: the town bar
 * and purse, then one character window — roster, vitals, and the three panes
 * (equipment around the silhouette, attributes, skills) — over the experience
 * line. Its stylesheet is `character.css`, mounted only while this screen is
 * (ruling R181). Selecting a member feeds all three panes the same character
 * (UI spec §7), every figure is the server's (ruling R182), and there is no
 * premium badge, no shop button and no element chip the server does not send.
 *
 * Allocation and skills are commands: each shows pending until the server
 * answers, and the account read that follows brings rank, points, derived
 * stats and unlocks together. A refused allocation keeps the player's draft
 * (B-16): see `AttributePane`.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Content, SkillId, Slot } from '@narok/data';
import type { AttributeKey } from '@narok/progression';
import sheet from '../character.css?raw';
import { CommandError, type CharacterSummary, type InventoryResponse } from '../commands';
import { classGlyphId, classNames, medalModifier, meterVar } from '../hud/model';
import { SpriteSheet } from '../hud/SpriteSheet';
import { WorldBackdrop } from '../hud/WorldBackdrop';
import { formatNumber } from '../i18n';
import { AttributePane, type AllocationNotice } from './AttributePane';
import { GearPane } from './GearPane';
import { allocationSummary, capacityOf, gearAttributes, shareOf, stageAttribute, wornBy, type AttributeSpend } from './model';
import { useRouteSheet } from './sheets';
import { SkillPane } from './SkillPane';
import { TownSprites } from './TownSprites';

export interface CharacterCommands {
  allocate(characterId: string, spend: AttributeSpend, quotedCost: number): Promise<void>;
  upgradeSkill(characterId: string, skillId: SkillId, targetRank: number): Promise<void>;
  unequip(characterId: string, slot: Slot): Promise<void>;
  /** Re-reads the account: characters, bag and presets. */
  refresh(): Promise<void>;
}

export type TownRoute = 'hunt' | 'bag' | 'character';

export interface CharacterScreenProps {
  readonly content: Content;
  readonly characters: readonly CharacterSummary[];
  readonly inventory: InventoryResponse | null;
  readonly hunting: boolean;
  readonly zone: string | null;
  readonly commands: CharacterCommands;
  readonly onNavigate: (route: TownRoute) => void;
  readonly initialCharacterId?: string;
}

export function CharacterScreen(props: CharacterScreenProps): React.JSX.Element {
  useRouteSheet('character', sheet);
  const { content, characters, inventory, hunting, zone, commands, onNavigate } = props;
  const { t, i18n } = useTranslation();
  const number = (value: number) => formatNumber(value, i18n.language);

  const [selectedId, setSelectedId] = useState<string | null>(props.initialCharacterId ?? null);
  const character = characters.find((entry) => entry.id === selectedId) ?? characters[0] ?? null;

  // Drafts are per character, so switching tabs never loses one.
  const [drafts, setDrafts] = useState<Record<string, AttributeSpend>>({});
  const [focus, setFocus] = useState<AttributeKey | null>(null);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<AllocationNotice>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [stagedSkill, setStagedSkill] = useState<SkillId | null>(null);
  const [learning, setLearning] = useState(false);

  useEffect(() => {
    setStagedSkill(null);
    setFocus(null);
  }, [character?.id]);

  const items = inventory?.items ?? [];
  const capacity = capacityOf(inventory);

  // The town bar and purse need no character: with an empty roster the
  // player can still navigate away (and nothing is drawn in its place).
  const townShell = (
    <>
      <header className="townbar win" aria-label={t('town.name')}>
        <div className="medal town-crest">
          <svg aria-hidden="true">
            <use href="#i-anvil" />
          </svg>
        </div>
        <div>
          <p className="town-name">{t('town.name')}</p>
          <p className="town-state">
            <i aria-hidden="true" />
            {hunting ? t('town.state.hunting') : t('town.state.inTown')}
          </p>
        </div>
        <nav className="nav" aria-label={t('town.nav.label')}>
          <button className="navbtn" type="button" aria-current="page">
            <svg aria-hidden="true">
              <use href="#i-figure" />
            </svg>
            {t('town.nav.character')}
          </button>
          <button className="navbtn" type="button" onClick={() => onNavigate('bag')}>
            <svg aria-hidden="true">
              <use href="#i-bag" />
            </svg>
            {t('town.nav.bag')}
          </button>
          <button className="navbtn navbtn--hunt" type="button" onClick={() => onNavigate('hunt')}>
            <svg aria-hidden="true">
              <use href="#i-swords" />
            </svg>
            {t('town.nav.hunt')} {zone !== null && <small>{t(`map.${zone}`)}</small>}
          </button>
        </nav>
      </header>

      <aside className="purse win" aria-label={t('town.account')}>
        {inventory !== null && (
          <div className="ledger-item ledger-gold">
            <svg aria-hidden="true">
              <use href="#i-coin" />
            </svg>
            <div>
              {number(inventory.gold)}
              <small>{t('town.gold')}</small>
            </div>
          </div>
        )}
        {capacity !== null && (
          <div className="ledger-item ledger-bag">
            <svg aria-hidden="true">
              <use href="#i-bag" />
            </svg>
            <div>
              {t('bag.occupancy', { used: number(capacity.used), capacity: number(capacity.capacity) })}
              <small>{t('town.bag')}</small>
            </div>
          </div>
        )}
      </aside>
    </>
  );

  if (character === null) {
    return (
      <div className="realm">
        <SpriteSheet />
        <TownSprites />
        <WorldBackdrop />
        {townShell}
      </div>
    );
  }

  const spend = drafts[character.id] ?? {};
  const attributes = character.attributes;
  const statPoints = character.statPoints ?? 0;

  const stage = (key: AttributeKey) => {
    if (attributes === undefined) return;
    const next = stageAttribute(attributes, statPoints, spend, key, content.progression.attributeCap);
    if (next.refused !== null) return;
    setDrafts((current) => ({ ...current, [character.id]: next.spend }));
    setFocus(key);
    setNotice(null);
  };

  const reset = () => {
    setDrafts((current) => ({ ...current, [character.id]: {} }));
    setFocus(null);
    setNotice(null);
  };

  const apply = () => {
    if (attributes === undefined || applying) return;
    const summary = allocationSummary(attributes, statPoints, spend);
    if (!summary.staged || !summary.affordable) return;
    const id = character.id;
    setApplying(true);
    setNotice(null);
    void (async () => {
      try {
        await commands.allocate(id, spend, summary.pending);
        // The draft is spent: the server's read now carries it.
        setDrafts((current) => ({ ...current, [id]: {} }));
        setFocus(null);
      } catch (error) {
        const code = error instanceof CommandError ? error.code : 'INTERNAL';
        const field = error instanceof CommandError ? error.field : '';
        // A stale account, or a cost that no longer matches it: re-read and
        // keep the draft for the player to review — never resend it unseen.
        if (code === 'CONFLICT_STATE_VERSION' || field === 'COST_MISMATCH' || field === 'INSUFFICIENT_POINTS') {
          setNotice('stale');
          await commands.refresh();
        } else {
          setNotice('refused');
          setRefusal(code);
        }
      } finally {
        setApplying(false);
      }
    })();
  };

  const learn = () => {
    if (stagedSkill === null || learning) return;
    const rank = character.skillRanks?.[stagedSkill] ?? 0;
    setLearning(true);
    void commands
      .upgradeSkill(character.id, stagedSkill, rank + 1)
      .then(() => setStagedSkill(null))
      .catch(() => commands.refresh())
      .finally(() => setLearning(false));
  };

  const expToNext = character.expToNext;
  const flagOf = (entry: CharacterSummary) => entry.statPoints ?? 0;

  return (
    <div className="realm">
      <SpriteSheet />
      <TownSprites />
      <WorldBackdrop />

      {townShell}

      <main className="charwin win" aria-labelledby="char-title">
        <h1 className="win-title" id="char-title">
          {t('character.title')} <span className="dash" aria-hidden="true">—</span> {character.name}
          <button className="win-close" type="button" aria-label={t('character.returnToHunt')} onClick={() => onNavigate('hunt')}>
            <svg aria-hidden="true">
              <use href="#i-close" />
            </svg>
          </button>
        </h1>

        <div className="char-head">
          <div className="roster" role="tablist" aria-label={t('character.roster')}>
            {characters.map((entry) => (
              <button
                key={entry.id}
                className="member"
                role="tab"
                type="button"
                aria-selected={entry.id === character.id}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className={classNames('medal', medalModifier(entry.classId))}>
                  <svg aria-hidden="true">
                    <use href={`#${classGlyphId(entry.classId)}`} />
                  </svg>
                  <span className="lvl num">{number(entry.level)}</span>
                </span>
                <span>
                  <span className="member-name">{entry.name}</span>
                  <span className="member-class">{t(`class.${entry.classId}`)}</span>
                </span>
                {flagOf(entry) > 0 && (
                  <span className="member-flag num" title={t('character.flag', { count: flagOf(entry) })}>
                    +{number(flagOf(entry))}
                  </span>
                )}
              </button>
            ))}
          </div>

          <section className="vitals" aria-label={t('character.vitals', { name: character.name })}>
            <div className="ident">
              <span className={classNames('medal', medalModifier(character.classId))}>
                <svg aria-hidden="true">
                  <use href={`#${classGlyphId(character.classId)}`} />
                </svg>
                <span className="lvl num">{number(character.level)}</span>
              </span>
              <h2 className="ident-name">{character.name}</h2>
              <p className="ident-line">{t('character.ident', { level: character.level, class: t(`class.${character.classId}`) })}</p>
            </div>
            {character.hp !== undefined && character.maxHp !== undefined && character.mp !== undefined && character.maxMp !== undefined && (
              <div>
                <div className="bar bar--hp" role="meter" aria-label={t('character.health')} aria-valuenow={character.hp} aria-valuemin={0} aria-valuemax={character.maxHp}>
                  <i style={{ '--v': meterVar(character.hp, character.maxHp) } as React.CSSProperties} />
                  <span>{t('bag.occupancy', { used: number(character.hp), capacity: number(character.maxHp) })}</span>
                </div>
                <div className="bar bar--mp" role="meter" aria-label={t('character.mana')} aria-valuenow={character.mp} aria-valuemin={0} aria-valuemax={character.maxMp}>
                  <i style={{ '--v': meterVar(character.mp, character.maxMp) } as React.CSSProperties} />
                  <span>{t('bag.occupancy', { used: number(character.mp), capacity: number(character.maxMp) })}</span>
                </div>
              </div>
            )}
            {character.exp !== undefined && expToNext !== undefined && (
              <div>
                <p className="bar-label">
                  <span>{expToNext === null ? t('character.expMax') : t('character.expTo', { level: character.level + 1 })}</span>
                </p>
                {expToNext !== null && (
                  <div className="bar bar--xp" role="meter" aria-label={t('character.experience')} aria-valuenow={character.exp} aria-valuemin={0} aria-valuemax={expToNext}>
                    <i style={{ '--v': meterVar(character.exp, expToNext) } as React.CSSProperties} />
                    <span>{t('bag.occupancy', { used: number(character.exp), capacity: number(expToNext) })}</span>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <div className="char-body">
          <GearPane
            character={character}
            items={items}
            content={content}
            hunting={hunting}
            onUnequip={(slot) => commands.unequip(character.id, slot).catch(() => commands.refresh())}
          />
          {attributes !== undefined && (
            <AttributePane
              character={character}
              attributes={attributes}
              gear={gearAttributes(wornBy(items, character.id), content)}
              content={content}
              spend={spend}
              focus={focus}
              hunting={hunting}
              applying={applying}
              notice={notice}
              refusal={refusal}
              onStage={stage}
              onApply={apply}
              onReset={reset}
            />
          )}
          <SkillPane
            character={character}
            content={content}
            hunting={hunting}
            staged={stagedSkill}
            learning={learning}
            onStage={setStagedSkill}
            onLearn={learn}
          />
        </div>
      </main>

      {character.exp !== undefined && typeof expToNext === 'number' && (
        <div
          className="expline"
          role="progressbar"
          aria-label={t('character.expTo', { level: character.level + 1 })}
          aria-valuenow={Math.round(shareOf(character.exp, expToNext))}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <i style={{ width: `${shareOf(character.exp, expToNext)}%` }} />
        </div>
      )}
    </div>
  );
}
