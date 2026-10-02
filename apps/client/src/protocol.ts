/**
 * The client half of the wire protocol (milestone B spec part 1 §3; part 4 §1).
 *
 * Milestone A's `worker-contract.ts` spoke to a worker the client owned: it
 * sent `advance` and the worker obeyed. Against the server the direction of
 * control is reversed. The client speaks three messages — `hello`, `heartbeat`
 * and `ack` — and none of them moves the authoritative clock; **there is no
 * `advance` here and there never will be.** The server speaks four: `frame`,
 * `snapshot`, `report` and `error`, each carrying a `generation`.
 *
 * The shapes are `@narok/protocol`'s, validated by its strict schemas, so this
 * file declares no wire type of its own. What it adds is the client's refusal
 * rule (part 4 §2 rule 2): a message carrying a `seed` or an `rng` field, or
 * any key the schema does not know, is a protocol invariant error surfaced as
 * `PROTOCOL` — never quietly stripped and applied.
 *
 * The three socket-only codes keep the meanings the worker contract gave the
 * first two: `STALE_GENERATION` names a message for a generation the client no
 * longer owns, `PROTOCOL` a broken message contract. `BACKPRESSURE` is new: the
 * server closed the socket because unacknowledged events exceeded its bound.
 */
import {
  clientMessageSchema,
  serverMessageSchema,
  type ClientMessage,
  type DomainEventWire,
  type ErrorCode,
  type Frame,
  type PublicStateWire,
  type ServerMessage,
  type Snapshot,
} from '@narok/protocol';

export type { ClientMessage, DomainEventWire, ErrorCode, Frame, PublicStateWire, ServerMessage, Snapshot };

/** The codes that only ever travel over the socket (part 1 §7: no HTTP status). */
export const SOCKET_ERROR_CODES = ['STALE_GENERATION', 'PROTOCOL', 'BACKPRESSURE'] as const;
export type SocketErrorCode = (typeof SOCKET_ERROR_CODES)[number];

/** A refusal the client raises, in the server's `{code, field}` shape. */
export interface ProtocolFault {
  readonly code: ErrorCode;
  readonly field: string;
}

/**
 * Keys that may never reach a client at any depth (part 1 §2's table: seeds,
 * PRNG state). The strict schemas already refuse them; naming them here makes
 * the refusal point at the smuggled key instead of at a union mismatch.
 */
const PRIVATE_KEYS: ReadonlySet<string> = new Set(['seed', 'rng']);

/** The dotted path of the first private key in `value`, or `null`. */
export function privateKeyPath(value: unknown, path: readonly string[] = []): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = privateKeyPath(value[index], [...path, String(index)]);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key)) return [...path, key].join('.');
    const found = privateKeyPath(child, [...path, key]);
    if (found !== null) return found;
  }
  return null;
}

export type Parsed = { readonly ok: true; readonly message: ServerMessage } | { readonly ok: false; readonly fault: ProtocolFault };

const FIELD_MAX = 120;

function bounded(field: string): string {
  return field.length > FIELD_MAX ? field.slice(0, FIELD_MAX) : field;
}

/**
 * Validates one inbound message. Accepts the raw socket text or an already
 * decoded value; returns the strictly parsed message or a `PROTOCOL` fault.
 */
export function parseServerMessage(raw: unknown): Parsed {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, fault: { code: 'PROTOCOL', field: 'message' } };
    }
  }
  const smuggled = privateKeyPath(data);
  if (smuggled !== null) return { ok: false, fault: { code: 'PROTOCOL', field: bounded(smuggled) } };

  const parsed = serverMessageSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const keys = issue !== undefined && 'keys' in issue ? (issue.keys as readonly string[]) : [];
    const path = [...(issue?.path ?? []), ...keys.slice(0, 1)].map(String).join('.');
    return { ok: false, fault: { code: 'PROTOCOL', field: bounded(path === '' ? 'message' : path) } };
  }
  return { ok: true, message: parsed.data as ServerMessage };
}

/** Serialises an outbound message, refusing anything outside the three the client may send. */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(clientMessageSchema.parse(message));
}
