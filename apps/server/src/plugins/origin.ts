/**
 * P-08: every mutating request and every socket upgrade is rejected unless its
 * `Origin` is on the allowlist.
 *
 * The check runs in `onRequest`, which is before any body parsing and before
 * any session lookup. That ordering is the requirement, not an optimisation: a
 * cross-site caller must not be able to learn whether a session exists by
 * comparing responses, so the refusal has to happen while the server still
 * knows nothing about who is asking.
 *
 * A read needs no `Origin`. It mutates nothing, and the session cookie is
 * `SameSite=Lax`, so a cross-site request cannot carry it in the first place.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import type { ServerConfig } from '../config';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isUpgrade(request: FastifyRequest): boolean {
  const upgrade = request.headers.upgrade;
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
}

export function registerOriginGuard(app: FastifyInstance, config: ServerConfig): void {
  const allowed = new Set(config.allowedOrigins);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const guarded = MUTATING.has(request.method) || isUpgrade(request);
    if (!guarded) return;

    const origin = request.headers.origin;
    // An absent Origin on a mutation is refused too: it is the shape an older
    // or scripted cross-site client takes, and nothing in this product needs it.
    if (typeof origin !== 'string' || !allowed.has(origin)) {
      const error = new AppError('FORBIDDEN_ORIGIN', 'origin');
      // Returning the reply is how an async hook tells Fastify the chain ended
      // here; without it the request continues to routing after the send.
      return reply.code(error.status).send(error.toEnvelope());
    }
    return undefined;
  });
}
