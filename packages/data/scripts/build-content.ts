import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prototypeDefinition } from '../src/prototype';
import type { Content } from '../src/types';
import { validateContent } from '../src/validate';
import { compileProgression } from './progression';

/**
 * Recursively sorts object keys by UTF-16 code-unit order, preserves array order,
 * and rejects values that cannot round-trip through JSON (functions, symbols,
 * undefined, NaN, Infinity). Used so the same content always hashes identically.
 */
function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite number in content: ${value}`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) result[key] = canonicalize(record[key]);
    return result;
  }
  throw new Error(`unsupported value in content: ${typeof value}`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildContent(): Content {
  const gridHash = sha256Hex(
    canonicalJson({ grid: prototypeDefinition.grid, shapes: prototypeDefinition.shapes }),
  );
  // The compiled tables are content: they are hashed into the version (ruling R134).
  const definition = { ...prototypeDefinition, progression: compileProgression() };
  const version = sha256Hex(canonicalJson(definition));
  const candidate: Content = { ...definition, version, gridHash };
  return validateContent(candidate);
}

function serializeModule(content: Content): string {
  const body = JSON.stringify(canonicalize(content), null, 2);
  return [
    '// GENERATED FILE. Run `pnpm build:data` to regenerate; do not edit by hand.',
    "import type { Content } from '../types';",
    '',
    `export const content: Content = ${body};`,
    '',
  ].join('\n');
}

function main(): void {
  const content = buildContent();
  const outputPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'generated', 'content.ts');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeModule(content), 'utf8');
}

main();
