/**
 * The REST half of the client (milestone B spec part 1 §3): the reads the HUD
 * binds and the commands the player issues. Every mutation is a command the
 * server may refuse, so nothing here changes local state optimistically — the
 * caller shows *pending* until the response arrives (part 4 §3.1, §3.2).
 *
 * A refusal comes back as `CommandError` carrying the server's stable code and
 * bounded field (part 1 §7). The client renders it through `i18n.ts` as
 * `serverError.<CODE>`; it never shows the server's text or its own English
 * (layer-1 §9). A response that is not the envelope becomes `INTERNAL`, never
 * a guess.
 *
 * Retriable mutations carry an `Idempotency-Key` (P-25). The session is the
 * cookie the browser already holds; nothing here reads or writes it (P-07).
 */
import type { Attributes, ItemInstance, Rarity, SkillId, Slot } from '@narok/data';
import type { LootPreset } from '@narok/loot';
import { errorEnvelopeSchema, type ErrorCode, type PublicStateWire, type StrategyPresetPayload } from '@narok/protocol';

export interface PresetRef {
  readonly presetId: string;
  readonly presetVersion: number;
}

export interface MeResponse {
  readonly id: string;
  readonly email: string;
  readonly stateVersion: number;
  readonly premium: boolean;
}

/** The derived combat stats the server computes with the engine's one formula (`deriveCharacter`). */
export interface DerivedStatsView {
  readonly maxHp: number;
  readonly maxMp: number;
  readonly atk: number;
  readonly matk: number;
  readonly def: number;
  readonly mdef: number;
  readonly hit: number;
  readonly flee: number;
  readonly critBp: number;
  readonly intervalMs: number;
}

/**
 * A character as `GET /api/characters` reads it (`characterView` in
 * `apps/server/src/routes/town.ts`). The identity fields are always present;
 * the progression fields are what the server sends, and a screen that finds
 * one absent leaves its panel out rather than filling it in (ruling R182).
 */
export interface CharacterSummary {
  readonly id: string;
  readonly slot: number;
  readonly name: string;
  readonly classId: string;
  readonly level: number;
  readonly exp?: number;
  readonly expToNext?: number | null;
  /** Allocated attributes, before gear. */
  readonly attributes?: Attributes;
  readonly statPoints?: number;
  readonly skillPoints?: number;
  readonly skillRanks?: Partial<Record<SkillId, number>>;
  readonly autoSpendTemplate?: {
    readonly targets: readonly { readonly attribute: keyof Attributes; readonly value: number }[];
    readonly remainder: keyof Attributes | null;
  } | null;
  readonly hp?: number;
  readonly mp?: number;
  readonly maxHp?: number;
  readonly maxMp?: number;
  readonly stats?: DerivedStatsView;
}

export interface CharactersResponse {
  readonly characters: readonly CharacterSummary[];
  readonly stateVersion: number;
}

export interface StrategyPresetRecord {
  readonly id: string;
  readonly name: string;
  readonly presetVersion: number;
  readonly payloadSchemaVersion: number;
  readonly payload: StrategyPresetPayload;
}

/**
 * A loot preset (ruling R183): its identity, and the payload the Bag screen's
 * filter pane shows and previews. A fixture or an older server may omit the
 * payload; the pane then shows the preset's name and nothing it cannot read.
 */
export interface LootPresetRecord {
  readonly id: string;
  readonly name: string;
  readonly presetVersion: number;
  readonly payloadSchemaVersion?: number;
  readonly payload?: LootPreset;
}

export interface PresetsResponse {
  readonly strategy: readonly StrategyPresetRecord[];
  readonly loot: readonly LootPresetRecord[];
  readonly stateVersion: number;
}

/** One consumable as the bag holds it: a total, and the stacks it occupies (ruling R137). */
export interface ConsumableStack {
  readonly consumableId: string;
  readonly quantity: number;
  readonly stacks: number;
}

/**
 * `GET /api/inventory`: the shared bag and the wallet, one read, one account
 * version. Every slot and gold counter on every screen comes from this one
 * returned state (part 4 §3.3, §4). `items` holds every owned instance,
 * equipped or not — only unequipped ones take a slot.
 */
export interface InventoryResponse {
  readonly capacity: number;
  readonly usedSlots: number;
  readonly gold: number;
  readonly stateVersion: number;
  readonly items?: readonly ItemInstance[];
  readonly consumables?: readonly ConsumableStack[];
}

/**
 * The away report as `GET /api/reports/:id` returns it (`AwayReport`, in
 * `apps/server/src/reports/away.ts`), decoded by {@link decodeAwayReport}.
 * The protocol package carries only the socket's `{type: 'report', reportId}`
 * notice, so the client states the fields it reads here.
 *
 * Report version 3 (Task 10 fix round 1) carries the map, each member's
 * outcome, the member deaths summed over the absence, the notable loot and the
 * bounded timeline. Ruling R194: a version-2 report — one already stored when
 * the server moved on — decodes those fields to `null`, and the screen leaves
 * out what is `null` rather than drawing an empty or zero section, because a
 * report that never carried a figure must not be shown as having counted none.
 * *Why not reset the stored rows:* only the latest report per account is kept
 * and it ages out under `reportRetentionMs`, so a decoder that tolerates the
 * old shape costs one function and needs no operator step.
 */
export type AwayStatus = 'running' | 'capped' | 'bag-full' | 'stopped';
export type AwayAction = 'view-hunt' | 'start-hunt' | 'manage-bag';

/** One party member across the absence. */
export interface AwayMemberRecord {
  readonly characterId: string;
  readonly classId: string;
  readonly levelBefore: number;
  readonly levelAfter: number;
  readonly expBefore: number;
  readonly expAfter: number;
  readonly deaths: number;
  readonly revives: number;
}

/** A kept equipment drop (ruling R193: rarest first, at most a handful). */
export interface AwayNotableRecord {
  readonly rewardId: string;
  readonly definitionId: string;
  readonly rarity: Rarity;
  readonly itemLevel: number;
  readonly bonusCount: number;
  readonly atWallMs: number;
}

export type AwayTimelineKind = 'won' | 'wipe' | 'death' | 'revive' | 'drop-lost' | 'stop' | 'cap';

/** One timeline entry (ruling R191): a course event, or a run of wins or of lost drops. */
export interface AwayTimelineRecord {
  readonly kind: AwayTimelineKind;
  readonly atWallMs: number;
  readonly characterId: string | null;
  readonly count: number;
  readonly reason: string | null;
}

export interface AwayReportRecord {
  readonly reportVersion: number;
  readonly huntId: string;
  readonly generation: number;
  readonly status: AwayStatus;
  readonly stopReason: NonNullable<PublicStateWire['stopReason']> | null;
  /** A stable key the client localizes (layer-1 §9). */
  readonly copyKey: string;
  readonly actions: readonly AwayAction[];
  readonly awayFromWall: number;
  readonly returnedAtWall: number;
  readonly timeAwayMs: number;
  readonly simulatedMs: number;
  readonly accrualEndedAtWall: number;
  readonly capCutoffWall: number;
  readonly uncovered: { readonly afterStopMs: number; readonly afterCapMs: number };
  readonly outcomes: {
    readonly kills: number;
    readonly wins: number;
    /** Wipes during this absence. */
    readonly wipes: number;
    readonly rawExp: number;
    readonly rawGold: number;
    readonly drops: {
      readonly rolled: number;
      readonly kept: number;
      readonly autoSold: number;
      readonly ignored: number;
      readonly lost: number;
    };
    readonly consumed: Readonly<Record<string, number>>;
  };
  /** Wipes over the whole hunt. */
  readonly wipesThisHunt: number;
  readonly rewardsCredited: number;
  /** Version 3 on; `null` when the report's version did not carry it (R194). */
  readonly mapId: string | null;
  readonly party: readonly AwayMemberRecord[] | null;
  /** Individual member deaths summed over the absence: the third count. */
  readonly memberDeaths: number | null;
  readonly notable: readonly AwayNotableRecord[] | null;
  readonly notableTotal: number | null;
  readonly timeline: readonly AwayTimelineRecord[] | null;
  readonly timelineOmitted: number | null;
}

/** The fields every report version carries. */
type AwayReportCore = Omit<AwayReportRecord, 'mapId' | 'party' | 'memberDeaths' | 'notable' | 'notableTotal' | 'timeline' | 'timelineOmitted'>;

/** A report as read: version 3's fields present, or absent on an older version. */
export type AwayReportWire = AwayReportCore & Partial<Omit<AwayReportRecord, keyof AwayReportCore>>;

/** The first report version that carries the map, the party, the notable loot and the timeline. */
export const AWAY_REPORT_V3 = 3;

/** Ruling R194: an older report's absent fields decode to `null`, never to an empty or zero section. */
export function decodeAwayReport(read: AwayReportWire): AwayReportRecord {
  const carries = read.reportVersion >= AWAY_REPORT_V3;
  const field = <T>(value: T | null | undefined): T | null => (carries && value !== undefined ? value : null);
  return {
    ...read,
    mapId: field(read.mapId),
    party: field(read.party),
    memberDeaths: field(read.memberDeaths),
    notable: field(read.notable),
    notableTotal: field(read.notableTotal),
    timeline: field(read.timeline),
    timelineOmitted: field(read.timelineOmitted),
  };
}

/** A character command's answer: the character as it now stands. */
export interface CharacterCommandResponse {
  readonly character: CharacterSummary;
  readonly stateVersion: number;
}

export interface EquipBody {
  readonly itemId: string;
  readonly characterId: string;
  readonly slot: Slot;
  readonly expectedStateVersion: number;
}

export interface UnequipBody {
  readonly characterId: string;
  readonly slot: Slot;
  readonly expectedStateVersion: number;
}

export interface LockBody {
  readonly itemId: string;
  readonly locked: boolean;
  readonly expectedStateVersion: number;
}

export interface AllocateBody {
  readonly spend: Partial<Record<keyof Attributes, number>>;
  /** The total cost the staging showed; the server refuses a mismatch (part 3 §5.3). */
  readonly quotedCost: number;
  readonly expectedStateVersion: number;
}

export interface UpgradeSkillBody {
  readonly skillId: SkillId;
  readonly targetRank: number;
  readonly expectedStateVersion: number;
}

export interface ApplyLootBody extends PresetRef {
  readonly expectedStateVersion: number;
  readonly expectedGeneration: number;
}

export interface SellBody {
  readonly itemIds: readonly string[];
  readonly expectedStateVersion: number;
}

/** `GET /api/hunts/current` and every hunt command's answer (the server's `HuntView`). */
export interface HuntResponse {
  readonly huntId: string;
  readonly generation: number;
  readonly stateVersion: number;
  readonly state: PublicStateWire;
  readonly activeStrategy: PresetRef;
  readonly pendingStrategy: PresetRef | null;
  /** The loot filter in force, and the one applied after the cutoff, separately (UI spec §6). */
  readonly activeLoot: PresetRef;
  readonly pendingLoot: PresetRef | null;
  /** Present on the read; the commands answer without it. */
  readonly status?: 'running' | 'stopped';
  readonly mapId?: string;
  readonly inTownAtWallMs?: number | null;
}

export interface SavePresetResponse extends PresetRef {
  readonly stateVersion: number;
}

export class CommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly field: string,
    readonly stateVersion?: number,
    readonly generation?: number,
  ) {
    super(`${code}:${field}`);
    this.name = 'CommandError';
  }
}

export interface StartHuntBody {
  readonly characterIds: readonly string[];
  readonly mapId: string;
  readonly strategyPresetId: string;
  readonly lootPresetId: string;
  readonly expectedStateVersion: number;
}

export interface ApplyStrategyBody extends PresetRef {
  readonly expectedStateVersion: number;
  readonly expectedGeneration: number;
}

export interface SavePresetBody {
  readonly payload: StrategyPresetPayload;
  readonly payloadSchemaVersion: number;
  /** The preset version the draft was loaded from (ruling R176). */
  readonly expectedPresetVersion: number;
  readonly expectedStateVersion: number;
}

export interface Api {
  me(): Promise<MeResponse>;
  characters(): Promise<CharactersResponse>;
  presets(): Promise<PresetsResponse>;
  inventory(): Promise<InventoryResponse>;
  currentHunt(): Promise<HuntResponse>;
  startHunt(body: StartHuntBody): Promise<HuntResponse>;
  stopHunt(): Promise<HuntResponse>;
  applyStrategy(body: ApplyStrategyBody): Promise<HuntResponse>;
  savePreset(presetId: string, body: SavePresetBody): Promise<SavePresetResponse>;
  /** A read: it settles nothing and credits nothing (B-17). */
  report(reportId: string): Promise<AwayReportWire>;
  equip(body: EquipBody): Promise<unknown>;
  unequip(body: UnequipBody): Promise<unknown>;
  lock(body: LockBody): Promise<unknown>;
  allocate(characterId: string, body: AllocateBody): Promise<CharacterCommandResponse>;
  upgradeSkill(characterId: string, body: UpgradeSkillBody): Promise<CharacterCommandResponse>;
  applyLoot(body: ApplyLootBody): Promise<HuntResponse>;
  /**
   * Bulk or single sale. Only reachable with `VITE_FEATURE_SHOP` on, which
   * defaults off: prices are deferred and the route is unimplemented, so B-15
   * stays open behind prices (ruling R185).
   */
  sell(body: SellBody): Promise<unknown>;
}

export interface ApiOptions {
  readonly fetch?: typeof fetch;
  /** A fresh idempotency key per *intent*; the default is a random UUID. */
  readonly newKey?: () => string;
}

function randomKey(): string {
  return globalThis.crypto.randomUUID();
}

async function refusal(response: Response): Promise<CommandError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new CommandError('INTERNAL', 'response');
  }
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (!parsed.success) return new CommandError('INTERNAL', 'response');
  const { code, field, stateVersion, generation } = parsed.data;
  return new CommandError(code, field, stateVersion, generation);
}

export function createApi(options: ApiOptions = {}): Api {
  const newKey = options.newKey ?? randomKey;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = newKey();
    }
    let response: Response;
    try {
      response = await doFetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
    } catch {
      // No connection at all: the server said nothing, so nothing is claimed.
      throw new CommandError('INTERNAL', 'network');
    }
    if (!response.ok) throw await refusal(response);
    return (await response.json()) as T;
  }

  return {
    me: () => call('GET', '/api/me'),
    characters: () => call('GET', '/api/characters'),
    presets: () => call('GET', '/api/presets'),
    inventory: () => call('GET', '/api/inventory'),
    currentHunt: () => call('GET', '/api/hunts/current'),
    startHunt: (body) => call('POST', '/api/hunts', body),
    stopHunt: () => call('POST', '/api/hunts/current/stop', {}),
    applyStrategy: (body) => call('POST', '/api/hunts/current/strategy', body),
    savePreset: (presetId, body) => call('PUT', `/api/presets/${encodeURIComponent(presetId)}`, body),
    report: (reportId) => call('GET', `/api/reports/${encodeURIComponent(reportId)}`),
    equip: (body) => call('POST', '/api/inventory/equip', body),
    unequip: (body) => call('POST', '/api/inventory/unequip', body),
    lock: (body) => call('POST', '/api/inventory/lock', body),
    allocate: (characterId, body) => call('POST', `/api/characters/${encodeURIComponent(characterId)}/attributes`, body),
    upgradeSkill: (characterId, body) => call('POST', `/api/characters/${encodeURIComponent(characterId)}/skills`, body),
    applyLoot: (body) => call('POST', '/api/hunts/current/loot', body),
    sell: (body) => call('POST', '/api/inventory/sell', body),
  };
}

/** The `{code, field}` of any thrown value, for rendering through `serverError.<CODE>`. */
export function faultOf(error: unknown): { code: ErrorCode; field: string } {
  if (error instanceof CommandError) return { code: error.code, field: error.field };
  return { code: 'INTERNAL', field: 'client' };
}
