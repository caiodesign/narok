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

export interface CharacterSummary {
  readonly id: string;
  readonly slot: number;
  readonly name: string;
  readonly classId: string;
  readonly level: number;
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

export interface LootPresetRecord {
  readonly id: string;
  readonly name: string;
  readonly presetVersion: number;
}

export interface PresetsResponse {
  readonly strategy: readonly StrategyPresetRecord[];
  readonly loot: readonly LootPresetRecord[];
  readonly stateVersion: number;
}

export interface InventoryResponse {
  readonly capacity: number;
  readonly usedSlots: number;
  readonly gold: number;
  readonly stateVersion: number;
}

/** `GET /api/hunts/current` and every hunt command's answer (the server's `HuntView`). */
export interface HuntResponse {
  readonly huntId: string;
  readonly generation: number;
  readonly stateVersion: number;
  readonly state: PublicStateWire;
  readonly activeStrategy: PresetRef;
  readonly pendingStrategy: PresetRef | null;
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
  };
}

/** The `{code, field}` of any thrown value, for rendering through `serverError.<CODE>`. */
export function faultOf(error: unknown): { code: ErrorCode; field: string } {
  if (error instanceof CommandError) return { code: error.code, field: error.field };
  return { code: 'INTERNAL', field: 'client' };
}
