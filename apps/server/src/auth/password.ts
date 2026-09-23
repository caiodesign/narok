/**
 * Password hashing (layer-1 §8.3, P-06).
 *
 * argon2id, with the cost taken from configuration and its parameters stored
 * beside the hash as an algorithm tag, so a future re-tuning can rehash on the
 * next successful login instead of stranding every account (part 1 §9 #2).
 *
 * The plaintext and the hash never leave this module in any direction other
 * than the database: nothing here logs, and the verify path returns a boolean
 * rather than a reason, so a caller cannot accidentally build a message that
 * distinguishes an unknown account from a wrong password.
 */
import { hash, verify } from '@node-rs/argon2';
import type { ServerConfig } from '../config';

export interface Hasher {
  hash(password: string): Promise<{ hash: string; algorithm: string }>;
  verify(stored: string, password: string): Promise<boolean>;
}

export function argon2Hasher(config: ServerConfig['argon2']): Hasher {
  const algorithm = `argon2id:m=${config.memoryCost},t=${config.timeCost},p=${config.parallelism}`;

  return {
    async hash(password: string) {
      return {
        hash: await hash(password, {
          memoryCost: config.memoryCost,
          timeCost: config.timeCost,
          parallelism: config.parallelism,
        }),
        algorithm,
      };
    },

    async verify(stored: string, password: string) {
      try {
        return await verify(stored, password);
      } catch {
        // A malformed stored hash is a failed verification, not a 500: the
        // caller must answer INVALID_CREDENTIALS either way (layer-1 §8.3).
        return false;
      }
    },
  };
}
