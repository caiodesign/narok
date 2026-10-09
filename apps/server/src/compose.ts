/**
 * Assembles the app's dependencies from the environment. `main.ts` only
 * listens; everything decided here is testable without starting a process.
 *
 * Without `DATABASE_URL` the server runs on the in-memory stores and `/ws`
 * answers MAINTENANCE, exactly as before. With it, accounts and sessions live
 * in PostgreSQL and the socket streams real hunts through the lifecycle.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { content, validateContent } from '@narok/data';
import { createGrid, createSimulation, type SimState } from '@narok/sim';
import type { AppDeps } from './app';
import { defaultConfig, type ServerConfig } from './config';
import { drizzleStores } from './db/repositories/accounts';
import * as schema from './db/schema';
import { defaultHuntConfig, validateHuntConfig } from './hunt/config';
import { LifecycleFeed } from './hunt/feed';
import { CommandSequencer } from './hunt/commands';
import { drawHuntSeed, PrecomputeCache, type LifecycleDeps } from './hunt/lifecycle';
import { memoryStores } from './store/memory';
import { inlineExecutor, SegmentPool } from './workers/pool';

/**
 * Proposed default, not a measurement: comfortably under the client's ~2 s
 * playback buffer (layer-1 §4.4 step 5), so playback never waits on a release.
 */
export const RELEASE_TICK_MS = 1_000;

/**
 * The engine version this build replays under. Typed by the engine's own
 * literal, so moving the engine to a new version fails the type check here
 * rather than silently refusing every stored checkpoint.
 */
const SIMULATION_VERSION: SimState['simulationVersion'] = 'b1';

export interface Composed {
  readonly deps: AppDeps;
  /** Closes what was opened; resolves at once when nothing was. */
  readonly close: () => Promise<void>;
}

export function configFromEnvironment(env: NodeJS.ProcessEnv): ServerConfig {
  const base = defaultConfig();
  const origins = env.NAROK_ALLOWED_ORIGINS;
  return {
    ...base,
    allowedOrigins: origins === undefined ? base.allowedOrigins : origins.split(',').map((value) => value.trim()),
    secureCookies: env.NAROK_INSECURE_COOKIES !== '1',
    trustProxy: env.NAROK_TRUST_PROXY === '1',
  };
}

export function compose(env: NodeJS.ProcessEnv, onLog?: (line: string) => void): Composed {
  const config = configFromEnvironment(env);
  const url = env.DATABASE_URL;
  if (url === undefined || url === '') {
    return { deps: { config, onLog }, close: async () => {} };
  }

  const client = postgres(url, { onnotice: () => {} });
  const db = drizzle(client, { schema });
  const now = () => Date.now();

  const validated = validateContent(content);
  const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));
  const lifecycle: LifecycleDeps = {
    db,
    sim,
    content: validated,
    pins: {
      simulationVersion: SIMULATION_VERSION,
      contentVersion: validated.version,
      gridHash: validated.gridHash,
    },
    config: validateHuntConfig(defaultHuntConfig()),
    now,
    drawSeed: () => drawHuntSeed(),
    newHuntId: () => crypto.randomUUID(),
    pool: new SegmentPool(inlineExecutor(sim)),
    precompute: new PrecomputeCache(),
  };

  // One command order per account, shared by the routes' commands and the
  // socket's settlements (R116, R120).
  const sequencer = new CommandSequencer(now);
  const feed = new LifecycleFeed({
    lifecycle,
    retainedEvents: config.bounds.unackedEventsPerSocket,
    releaseTickMs: RELEASE_TICK_MS,
    sequencer,
    onLog,
  });

  // The audit and command-result stores are task 4's; until then the app's
  // own routes keep the in-memory ones, and hunt commands write both tables
  // directly inside their transactions.
  const fallback = memoryStores({ now });
  return {
    deps: {
      config,
      onLog,
      now,
      stores: {
        ...drizzleStores(db, { now, bagCapacity: 100 }),
        audit: fallback.audit,
        commands: fallback.commands,
      },
      huntFeed: feed,
      hunts: { lifecycle, feed, sequencer },
    },
    close: () => client.end({ timeout: 5 }),
  };
}
