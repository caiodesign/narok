/**
 * Task 11 — gates B-02 (bundle half) and B-19: what ships, grepped.
 *
 * B-02: the production client bundle contains no engine entry point. Minified
 * builds rename functions, so a grep for `advance` or `createSimulation` would
 * prove nothing; instead this greps for **string literals that exist only in
 * `@narok/sim`'s engine modules** (its version-mismatch, scheduler and codec
 * errors), which survive minification wherever the code does. The laboratory
 * bundle, which does ship the engine (R164), is the positive control: the same
 * grep must find them there, or the method is blind.
 *
 * B-19: the built client bundle and both committed locale files, grepped for
 * every forbidden concept of part 4 §4. Every match is printed with context so
 * a reader can judge it; a match is evidence to read, not a verdict.
 *
 * Usage (after `pnpm --filter @narok/client build && pnpm --filter @narok/lab build`):
 *   node artifacts/bundle-grep.mjs artifacts/b02-b19-grep.txt
 * Exit status 1 when the client bundle carries an engine literal or the
 * positive control finds none; B-19 matches never change the exit status.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'artifacts/b02-b19-grep.txt';
const lines = [];
const log = (line = '') => {
  lines.push(line);
  console.log(line);
};

function files(dir, filter) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...files(path, filter));
    else if (filter(path)) found.push(path);
  }
  return found.sort();
}

function grep(paths, pattern) {
  const hits = [];
  for (const path of paths) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
      const start = Math.max(0, match.index - 50);
      const context = text.slice(start, match.index + match[0].length + 50).replace(/\s+/g, ' ');
      hits.push({ path: path.replace(/\\/g, '/'), match: match[0], context });
    }
  }
  return hits;
}

// Engine-only literals: each appears in packages/sim/src and nowhere the client may import.
const ENGINE_LITERALS = [
  'state was produced by different content', // advance.ts, assertCompatible
  'state was produced by a different grid', // advance.ts
  'simulation time moved backwards', // advance.ts
  'a queued entry is scheduled in the past', // advance.ts / scheduler
  'target is before the current simulation time', // advance.ts
  'cannot encode a non-finite number', // snapshot.ts
];

const clientJs = files('apps/client/dist', (path) => path.endsWith('.js'));
const labJs = files('apps/lab/dist', (path) => path.endsWith('.js'));

log('# B-02 — engine literals in the shipped client bundle');
log(`client files: ${clientJs.length} (.js under apps/client/dist)`);
log(`lab files (positive control): ${labJs.length} (.js under apps/lab/dist)`);
let clientHits = 0;
let labHits = 0;
for (const literal of ENGINE_LITERALS) {
  const pattern = new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const inClient = grep(clientJs, pattern).length;
  const inLab = grep(labJs, pattern).length;
  clientHits += inClient;
  labHits += inLab;
  log(`  "${literal}": client ${inClient}, lab ${inLab}`);
}
log(`client total: ${clientHits}; lab total: ${labHits}`);
const b02 = clientHits === 0 && labHits > 0;
log(`B-02 bundle half: ${b02 ? 'no engine literal in the client bundle; the control finds them in the lab bundle' : 'FAILED'}`);
log();

// Part 4 §4's forbidden concepts. Case-insensitive; EN and PT-BR spellings.
const FORBIDDEN = [
  ['premium offline cap (17h42m)', /17\s*h\s*42|17h42/i],
  ['premium (any mention)', /premium|premi[uo]/i],
  ['EXP loss / level loss', /exp(erience)?\s*loss|level\s*loss|perda\s+de\s+(exp|n[ií]vel|experi)/i],
  ['de-levelling', /de-?level|lose\s+a\s+level|perde(r)?\s+(um\s+)?n[ií]vel/i],
  ['time until death / forecast', /until\s+death|time\s+to\s+death|\+45\s*m|at[eé]\s+a\s+morte|previs[aã]o/i],
  ['two-level skill divisor', /every\s+(2|two)\s+levels|a\s+cada\s+(2|dois)\s+n[ií]veis/i],
  ['Materials tab', /materials|materiais/i],
  ['paid bag expansion', /bag\s+expansion|expand\s+(the\s+)?bag|expans[aã]o\s+d[ae]\s+bolsa|ampliar\s+(a\s+)?bolsa/i],
  ['fourth preset', /fourth\s+preset|4th\s+preset|quarto\s+preset/i],
  ['gallery', /gallery|galeria/i],
  ['compare original', /compare[\s-]+original|comparar\s+(com\s+o\s+)?original/i],
];

const locales = ['apps/client/src/locales/en.json', 'apps/client/src/locales/pt-BR.json'];
log('# B-19 — forbidden concepts in the client bundle and both locale files');
for (const [concept, pattern] of FORBIDDEN) {
  const hits = [...grep(clientJs, pattern), ...grep(locales, pattern)];
  log(`## ${concept}  /${pattern.source}/${pattern.flags}: ${hits.length} match(es)`);
  for (const hit of hits.slice(0, 12)) log(`  ${hit.path}: «${hit.match}» … ${hit.context}`);
  if (hits.length > 12) log(`  … ${hits.length - 12} more`);
}

writeFileSync(out, `${lines.join('\n')}\n`);
process.exit(b02 ? 0 : 1);
