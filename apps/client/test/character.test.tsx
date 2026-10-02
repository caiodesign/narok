// @vitest-environment jsdom
/**
 * The Character screen (milestone B Task 10; part 4 §3.4; UI spec §7; B-16).
 *
 * Staged allocation shows unspent and pending cost distinctly, previews each
 * control before and after, refuses what the character cannot afford, and
 * commits atomically. A stale account answer refreshes and revalidates the
 * draft: it never overspends and never silently discards it. A skill that
 * cannot be raised names what it is missing, and the skill-point curve is
 * content's — no divisor literal appears in any town component.
 */
import '@testing-library/jest-dom/vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { content, type Content } from '@narok/data';
import { statCost, statStepCost } from '@narok/progression';
import { CommandError, type CharacterSummary } from '../src/commands';
import i18n from '../src/i18n';
import en from '../src/locales/en.json';
import { CharacterScreen, type CharacterCommands } from '../src/town/CharacterScreen';
import { gate, type Gate } from './hunt-fakes';
import { bag, character, item, KAIO, PARTY } from './town-fixtures';

afterEach(() => {
  cleanup();
});

interface Held extends CharacterCommands {
  allocations: { characterId: string; spend: Record<string, number>; quotedCost: number; gate: Gate<void> }[];
  upgrades: unknown[][];
  unequips: unknown[][];
  refreshes: number;
  /** When set, the next skill upgrade or unequip is refused with it. */
  refuse: { upgradeSkill?: CommandError; unequip?: CommandError };
}

function held(): Held {
  const record: Held = {
    allocations: [],
    upgrades: [],
    unequips: [],
    refreshes: 0,
    refuse: {},
    allocate: (characterId, spend, quotedCost) => {
      const answer = gate<void>();
      record.allocations.push({ characterId, spend: { ...spend } as Record<string, number>, quotedCost, gate: answer });
      return answer.promise;
    },
    upgradeSkill: async (...args) => {
      record.upgrades.push(args);
      if (record.refuse.upgradeSkill !== undefined) throw record.refuse.upgradeSkill;
    },
    unequip: async (...args) => {
      record.unequips.push(args);
      if (record.refuse.unequip !== undefined) throw record.refuse.unequip;
    },
    refresh: async () => {
      record.refreshes += 1;
    },
  };
  return record;
}

function mount(characters: readonly CharacterSummary[], commands: CharacterCommands, hunting = false, tables: Content = content) {
  const props = {
    content: tables,
    inventory: bag([item({ definitionId: 'ranger-bow', equipped: { characterId: KAIO, slot: 'weapon' } })]),
    hunting,
    zone: 'prototype',
    commands,
    onNavigate: () => undefined,
    initialCharacterId: KAIO,
  };
  const view = render(<CharacterScreen {...props} characters={characters} />);
  return { ...view, rerenderWith: (next: readonly CharacterSummary[]) => view.rerender(<CharacterScreen {...props} characters={next} />) };
}

const attrs = () => document.querySelector('.attrs') as HTMLElement;
const row = (abbr: string) => within(attrs()).getByText(abbr, { selector: 'abbr' }).closest('.attr') as HTMLElement;
const raise = (abbr: string) => within(row(abbr)).getByRole('button');
const preview = () => attrs().querySelector('.allocation-preview') as HTMLElement;

describe('B-16: staged allocation', () => {
  test('unspent and pending cost are shown distinctly, with a per-control before/after', () => {
    mount(PARTY, held());
    const cost = statStepCost(11);
    expect(within(attrs()).getByText(String(7), { selector: '.pts' })).toBeInTheDocument();
    fireEvent.click(raise('DEX'));
    expect(row('DEX')).toHaveClass('is-staged');
    expect(row('DEX').querySelector('.attr-total')).toHaveTextContent('12');
    expect(preview()).toHaveTextContent(i18n.t('character.stepPreview', { attr: 'DEX', from: 11, to: 12, cost }));
    expect(preview()).toHaveTextContent(i18n.t('character.pending', { pending: cost, remaining: 7 - cost }));
    // Unspent stays the server's figure until the commit lands.
    expect(within(attrs()).getByText(String(7), { selector: '.pts' })).toBeInTheDocument();
  });

  test('a point the character cannot afford is refused, and says so', () => {
    mount([character({ id: KAIO, slot: 2, name: 'Kaio', classId: 'ranger', statPoints: 3 })], held());
    const cost = statStepCost(11);
    fireEvent.click(raise('DEX'));
    const next = statStepCost(12);
    expect(raise('DEX')).toBeDisabled();
    expect(raise('DEX')).toHaveAccessibleName(i18n.t('character.raiseRefused', { attr: 'DEX', cost: next }));
    expect(preview()).toHaveTextContent(i18n.t('character.pending', { pending: cost, remaining: 3 - cost }));
  });

  test('Reset is local: the draft clears and no command is sent', () => {
    const commands = held();
    mount(PARTY, commands);
    fireEvent.click(raise('AGI'));
    fireEvent.click(within(preview()).getByRole('button', { name: en.character.reset }));
    expect(row('AGI')).not.toHaveClass('is-staged');
    expect(commands.allocations).toEqual([]);
  });

  test('Apply commits the whole draft once, with the cost the player saw', async () => {
    const commands = held();
    const view = mount(PARTY, commands);
    fireEvent.click(raise('DEX'));
    fireEvent.click(raise('AGI'));
    const apply = within(preview()).getByRole('button', { name: en.character.apply });
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(commands.allocations).toHaveLength(1);
    expect(commands.allocations[0]).toMatchObject({ characterId: KAIO, spend: { dex: 1, agi: 1 }, quotedCost: statCost(11, 12) + statCost(5, 6) });
    expect(within(preview()).getByRole('button', { name: en.character.applying })).toBeDisabled();

    const committed = PARTY.map((entry) =>
      entry.id === KAIO ? { ...entry, statPoints: 7 - commands.allocations[0]!.quotedCost, attributes: { ...entry.attributes!, dex: 12, agi: 6 } } : entry,
    );
    await act(async () => {
      commands.allocations[0]!.gate.resolve();
    });
    view.rerenderWith(committed);
    expect(row('DEX')).not.toHaveClass('is-staged');
    expect(row('DEX').querySelector('.attr-total')).toHaveTextContent('12');
    expect(within(attrs()).getByText(String(7 - commands.allocations[0]!.quotedCost), { selector: '.pts' })).toBeInTheDocument();
  });

  test('a stale account refreshes and revalidates the draft: kept, explained, never overspent', async () => {
    const commands = held();
    const view = mount(PARTY, commands);
    fireEvent.click(raise('DEX'));
    fireEvent.click(within(preview()).getByRole('button', { name: en.character.apply }));
    await act(async () => {
      commands.allocations[0]!.gate.reject(new CommandError('CONFLICT_STATE_VERSION', 'expectedStateVersion', 9));
    });
    // The command layer already re-read the account on a stale version (R189); the screen does not read it twice.
    expect(commands.refreshes).toBe(0);
    expect(preview()).toHaveTextContent(en.character.stale);
    expect(row('DEX')).toHaveClass('is-staged');

    // The fresh read: an auto-spend elsewhere left one point.
    view.rerenderWith(PARTY.map((entry) => (entry.id === KAIO ? { ...entry, statPoints: 1 } : entry)));
    expect(row('DEX')).toHaveClass('is-staged');
    expect(preview()).toHaveTextContent(i18n.t('character.insufficient', { pending: statStepCost(11), unspent: 1 }));
    expect(within(preview()).getByRole('button', { name: en.character.apply })).toBeDisabled();
    expect(commands.allocations).toHaveLength(1);
  });
});

describe('a stale cost (Minor 4)', () => {
  test('a cost the server no longer agrees with re-reads the account once, and keeps the draft', async () => {
    const commands = held();
    mount(PARTY, commands);
    fireEvent.click(raise('DEX'));
    fireEvent.click(within(preview()).getByRole('button', { name: en.character.apply }));
    await act(async () => {
      commands.allocations[0]!.gate.reject(new CommandError('RULE_VIOLATION', 'COST_MISMATCH'));
    });
    expect(commands.refreshes).toBe(1);
    expect(preview()).toHaveTextContent(en.character.stale);
    expect(row('DEX')).toHaveClass('is-staged');
  });
});

describe('refusals are rendered from the server’s code, scoped to the command that failed (I3)', () => {
  const refusal = (code: 'RULE_VIOLATION' | 'CONFLICT_STATE_VERSION') => i18n.t('town.refused', { reason: i18n.t(`serverError.${code}`) });

  async function learnFirst(commands: Held) {
    const skills = document.querySelector('.skills') as HTMLElement;
    const first = content.classes.ranger.skills[0]!;
    const rowOf = within(skills).getByText(i18n.t(`skill.${first}`), { selector: '.skill-title' }).closest('.skillrow') as HTMLElement;
    fireEvent.click(within(rowOf).getByRole('button'));
    await act(async () => {
      fireEvent.click(within(skills).getByRole('button', { name: en.character.learn }));
    });
    expect(commands.upgrades).toHaveLength(1);
    return skills;
  }

  test('a refused skill rank says why, keeps the staged rank, and nothing else shows it', async () => {
    const commands = held();
    commands.refuse.upgradeSkill = new CommandError('RULE_VIOLATION', 'skillPoints');
    mount(PARTY, commands);
    const skills = await learnFirst(commands);
    expect(within(skills).getByRole('alert')).toHaveTextContent(refusal('RULE_VIOLATION'));
    expect(within(skills).getByRole('button', { name: en.character.learn })).toBeEnabled();
    expect(within(attrs()).queryByRole('alert')).toBeNull();
    expect(within(document.querySelector('.gear-pane') as HTMLElement).queryByRole('alert')).toBeNull();
  });

  test('a refused unequip says why and keeps the item tip open; a later success clears it', async () => {
    const commands = held();
    commands.refuse.unequip = new CommandError('CONFLICT_STATE_VERSION', 'expectedStateVersion');
    mount(PARTY, commands);
    const gear = document.querySelector('.gear-pane') as HTMLElement;
    fireEvent.click(within(gear).getByText(i18n.t('item.ranger-bow'), { selector: '.gear-name' }).closest('.gear') as HTMLElement);
    await act(async () => {
      fireEvent.click(within(gear).getByRole('button', { name: en.character.unequip }));
    });
    expect(commands.unequips).toEqual([[KAIO, 'weapon']]);
    expect(within(gear).getByRole('alert')).toHaveTextContent(refusal('CONFLICT_STATE_VERSION'));
    expect(gear.querySelector('.itip')).not.toBeNull();
    expect(within(document.querySelector('.skills') as HTMLElement).queryByRole('alert')).toBeNull();

    commands.refuse.unequip = undefined;
    await act(async () => {
      fireEvent.click(within(gear).getByRole('button', { name: en.character.unequip }));
    });
    expect(within(gear).queryByRole('alert')).toBeNull();
    expect(gear.querySelector('.itip')).toBeNull();
  });
});

describe('copy in its own context (Minor 5)', () => {
  test('allocation while hunting says to return to town to allocate, not to learn', () => {
    mount(PARTY, held(), true);
    expect(preview()).toHaveTextContent(en.character.allocateTown);
    expect(preview()).not.toHaveTextContent(en.character.skill.missing.town);
  });

  test('the HP, MP and EXP bars use the character’s own copy', () => {
    mount(PARTY, held());
    const kaio = PARTY[2]!;
    expect(document.querySelector('.bar--hp span')).toHaveTextContent(i18n.t('character.bar', { value: kaio.hp, max: kaio.maxHp }));
    expect(document.querySelector('.bar--xp span')).toHaveTextContent(i18n.t('character.bar', { value: kaio.exp, max: kaio.expToNext }));
  });
});

describe('B-16: skills', () => {
  test('a skill that cannot be raised names what it is missing', () => {
    mount([character({ id: KAIO, slot: 2, name: 'Kaio', classId: 'ranger', skillPoints: 0 })], held(), true);
    const skills = document.querySelector('.skills') as HTMLElement;
    const locked = skills.querySelectorAll('.skillrow--locked');
    expect(locked.length).toBe(content.classes.ranger.skills.length);
    expect(locked[0]).toHaveTextContent(en.character.skill.missing.town);
    expect(locked[0]).toHaveTextContent(en.character.skill.missing.points);
  });

  test('a rank is staged, previewed and then learned as one command', async () => {
    const commands = held();
    mount(PARTY, commands);
    const skills = document.querySelector('.skills') as HTMLElement;
    const first = content.classes.ranger.skills[0]!;
    const rowOf = within(skills).getByText(i18n.t(`skill.${first}`), { selector: '.skill-title' }).closest('.skillrow') as HTMLElement;
    fireEvent.click(within(rowOf).getByRole('button'));
    expect(skills).toHaveTextContent(i18n.t('character.skillPreview', { skill: i18n.t(`skill.${first}`), from: 0, to: 1 }));
    await act(async () => {
      fireEvent.click(within(skills).getByRole('button', { name: en.character.learn }));
    });
    expect(commands.upgrades).toEqual([[KAIO, first, 1]]);
  });

  test('the next skill point is read from content’s curve (Minor 8: checked against the table, not the function)', () => {
    // Content's own table, read here directly: the first level above 2 whose entry awards a point.
    const table = content.progression.skillPoints;
    const expected = table.findIndex((points, index) => index + 1 > 2 && points > 0) + 1;
    expect(expected).toBeGreaterThan(2);
    mount(PARTY, held());
    expect(document.querySelector('.skills-foot')).toHaveTextContent(i18n.t('character.nextSkillPoint', { level: expected }));
    cleanup();

    // A different table moves the footer with it: the component holds no curve of its own.
    const everyLevel: Content = { ...content, progression: { ...content.progression, skillPoints: table.map(() => 1) } };
    mount(PARTY, held(), false, everyLevel);
    expect(document.querySelector('.skills-foot')).toHaveTextContent(i18n.t('character.nextSkillPoint', { level: 3 }));
  });

  test('no town component carries a divisor literal', () => {
    const dir = resolve(__dirname, '../src/town');
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.tsx'))
      .flatMap((file) =>
        readFileSync(join(dir, file), 'utf8')
          .split('\n')
          .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
          .filter((line) => /[^/*]\s*[/%]\s*\d/.test(line.replace(/\/\/.*$/, '').replace(/'[^']*'/g, "''")))
          .map((line) => `${file}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});

describe('the character shell', () => {
  test('selecting a member updates every pane together; no premium, no shop', () => {
    mount(PARTY, held());
    expect(screen.getByRole('heading', { level: 2, name: 'Kaio' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Sigrun/ }));
    expect(screen.getByRole('heading', { level: 2, name: 'Sigrun' })).toBeInTheDocument();
    const skills = document.querySelector('.skills') as HTMLElement;
    expect(within(skills).getByText(i18n.t(`skill.${content.classes.cleric.skills[0]}`))).toBeInTheDocument();
    expect(document.querySelector('.prem-tag')).toBeNull();
    expect(document.querySelector('.ledger-premium')).toBeNull();
    expect(screen.queryByRole('button', { name: /shop/i })).toBeNull();
  });

  test('the worn item is on its slot, and Unequip is town-only', () => {
    const commands = held();
    mount(PARTY, commands, true);
    const gear = document.querySelector('.gear-pane') as HTMLElement;
    const weapon = within(gear).getByText(i18n.t('item.ranger-bow'), { selector: '.gear-name' }).closest('.gear') as HTMLElement;
    fireEvent.click(weapon);
    expect(within(gear).getByRole('button', { name: en.bag.block.hunting })).toBeDisabled();
  });
});
