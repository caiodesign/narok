export type SimErrorCode =
  | 'INVALID_CONTENT'
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'WRONG_VERSION'
  | 'TIME_REWIND'
  | 'UNSAFE_INTEGER'
  | 'LOOP_DETECTED';

/**
 * Thrown at public simulation boundaries. `field` is a bounded diagnostic path
 * (e.g. `input.placement.p0`); the message never embeds a serialized state.
 */
export class SimError extends Error {
  readonly code: SimErrorCode;
  readonly field: string;

  constructor(code: SimErrorCode, field: string, message: string) {
    super(message);
    this.name = 'SimError';
    this.code = code;
    this.field = field;
  }
}
