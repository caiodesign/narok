/**
 * Every error code the laboratory's worker can post is translated in both of the
 * client's languages. This case lived in the client's `i18n.test.ts` until the
 * worker moved to `apps/lab` (milestone B Task 8); the client may not import the
 * lab (ruling R164), so the lab checks its own codes against `@narok/client`.
 */
import { describe, expect, test } from 'vitest';
import { resources, SUPPORTED_LANGUAGES } from '@narok/client/src/i18n';
import type { WorkerErrorCode } from '../src/worker-contract';

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

describe('worker error codes', () => {
  test('every worker error code has a non-empty key in every language', () => {
    // Typed as an exhaustive Record so a code added to the union fails to compile
    // here rather than silently reaching the UI untranslated.
    const errorCodes: Record<WorkerErrorCode, true> = {
      INVALID_CONTENT: true,
      INVALID_INPUT: true,
      INVALID_STATE: true,
      WRONG_VERSION: true,
      TIME_REWIND: true,
      UNSAFE_INTEGER: true,
      LOOP_DETECTED: true,
      STALE_GENERATION: true,
      PROTOCOL: true,
      INTERNAL: true,
    };
    for (const language of SUPPORTED_LANGUAGES) {
      const tree = resources[language].translation as unknown as Tree;
      const missing = Object.keys(errorCodes).filter((code) => !lookup(tree, `error.${code}`));
      expect(missing).toEqual([]);
    }
  });
});
