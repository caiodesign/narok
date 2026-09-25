/**
 * The authenticated reads and the command routes task 1 stands up so its
 * rules — ownership, the guard, idempotency parsing, the deferred shop — are
 * decided and tested before task 2 gives them a database.
 *
 * Everything that mutates follows the same three steps in the same order, and
 * the order is the requirement (layer-1 §8.1): resolve the caller, check
 * ownership of everything named, then validate the business rule. Ownership
 * before validation is what keeps a cross-account probe from learning whether
 * an object exists by reading which complaint comes back.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { content } from '@narok/data';
import {
  applyStrategyCommandSchema,
  buyRequestSchema,
  lockCommandSchema,
  startHuntCommandSchema,
} from '@narok/protocol';
import { AppError, notOwned } from '../errors';
import { requireSession } from '../plugins/session';
import type { RouteContext } from './context';

/** P-25: an idempotent route without its key is a validation failure. */
function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    throw new AppError('VALIDATION', 'idempotency-key');
  }
  return key;
}

export function registerAccountRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { stores, config, now, parse } = ctx;
  const caller = (request: FastifyRequest) => requireSession(request, stores, config, now());

  app.get('/api/me', async (request) => {
    const { account } = await caller(request);
    return {
      id: account.id,
      email: account.email,
      stateVersion: account.stateVersion,
      premium: account.premium,
      versions: {
        simulationVersion: 'b1',
        contentVersion: content.version,
        gridHash: content.gridHash,
      },
    };
  });

  app.post('/api/inventory/lock', async (request) => {
    const { account } = await caller(request);
    requireIdempotencyKey(request);
    const body = parse(lockCommandSchema, request.body);

    // Ownership first, and absent answers exactly as not-yours does (P-12).
    const item = await stores.items.byId(body.itemId);
    if (item === undefined || item.accountId !== account.id) throw notOwned('itemId');

    // P-20's guard. Task 2 moves this inside the transaction that also does the
    // version increment; here it decides the same answer over the same read.
    if (body.expectedStateVersion !== account.stateVersion) {
      throw new AppError('CONFLICT_STATE_VERSION', 'expectedStateVersion', account.stateVersion);
    }

    await stores.items.setLocked(item.id, body.locked);
    return { itemId: item.id, locked: body.locked, stateVersion: account.stateVersion };
  });

  app.post('/api/hunts', async (request) => {
    await caller(request);
    requireIdempotencyKey(request);
    // Strict schemas: a smuggled `seed`, `elapsedMs` or `commandAt` is rejected
    // here rather than silently ignored (part 1 §2).
    parse(startHuntCommandSchema, request.body);
    // The lifecycle itself is task 3.
    throw new AppError('RULE_VIOLATION', 'hunts.start');
  });

  app.post('/api/hunts/current/strategy', async (request) => {
    await caller(request);
    requireIdempotencyKey(request);
    parse(applyStrategyCommandSchema, request.body);
    throw new AppError('RULE_VIOLATION', 'hunts.strategy');
  });

  app.post('/api/shop/buy', async (request) => {
    await caller(request);
    requireIdempotencyKey(request);
    parse(buyRequestSchema, request.body);
    // Prices are deferred by the owner (spec §4.0), so the shop is registered
    // and disabled rather than absent: the route exists, and says why.
    if (!config.features.shop) throw new AppError('MAINTENANCE', 'shop');
    throw new AppError('RULE_VIOLATION', 'shop.buy');
  });

  app.get('/api/reports/:id', async (request) => {
    const { account } = await caller(request);
    const { id } = request.params as { id: string };
    // No report exists yet (task 4). Answering NOT_OWNED keeps absence and
    // non-ownership indistinguishable, which is the rule that matters (P-12).
    void account;
    void id;
    throw notOwned('reportId');
  });
}
