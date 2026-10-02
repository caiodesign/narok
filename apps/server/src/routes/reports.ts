/**
 * `GET /api/reports/:id` (part 1 §3; UI spec §8; B-17).
 *
 * A read, and only a read: it resolves the caller, selects the one report row
 * the caller owns, and returns its payload. It settles nothing, takes no
 * account version and writes no row, so opening, reopening or refreshing a
 * report cannot credit anything a second time. Absent and not-yours answer
 * identically (P-12).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db/tx';
import { requireSession } from '../plugins/session';
import { readAwayReport } from '../reports/away';
import type { RouteContext } from './context';

export function registerReportRoutes(app: FastifyInstance, ctx: RouteContext, db: Database): void {
  const { stores, config, now } = ctx;
  const caller = (request: FastifyRequest) => requireSession(request, stores, config, now());

  app.get('/api/reports/:id', async (request) => {
    const { account } = await caller(request);
    const { id } = request.params as { id: string };
    return readAwayReport(db, account.id, id, now());
  });
}
