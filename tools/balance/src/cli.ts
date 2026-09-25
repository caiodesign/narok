import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { content } from '@narok/data';
import { benchmark, writeBenchmark } from './benchmark';
import { writeCsv } from './csv';
import {
  CliError,
  hoursToMs,
  parseHours,
  parseHoursList,
  parseOut,
  parseParty,
  parsePlacement,
  parseRecipe,
  parseRuns,
  parseSeeds,
} from './args';
import { buildLabInput, runBatch, runMatrix } from './run';
import type { RunResult } from './types';

type CliArgs = Record<string, string | boolean | undefined>;

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Writes `text` to `outPath`, creating only that artifact's own parent directory
 * (rulings R47) — never any unrelated directory.
 */
function writeArtifact(outPath: string, text: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, 'utf8');
}

/**
 * Per-actor detail and run parameters go in a companion JSON next to the CSV
 * (rulings R48): `<out>.actors.json`.
 */
function writeActorsCompanion(
  outPath: string,
  rows: RunResult[],
  parameters: Record<string, unknown>,
): void {
  const payload = {
    parameters,
    simulationVersion: 'b1',
    contentVersion: content.version,
    gridHash: content.gridHash,
    runs: rows.map((row) => ({
      seed: row.seed,
      roster: row.roster,
      recipe: row.recipe,
      placement: row.placement,
      actors: row.metrics.actors,
    })),
  };
  writeArtifact(`${outPath}.actors.json`, JSON.stringify(payload, null, 2) + '\n');
}

function runCommand(args: CliArgs): void {
  const hours = parseHours(asString(args.hours));
  const untilMs = hoursToMs(hours);
  const seeds = parseSeeds(asString(args.seeds));
  const classes = parseParty(asString(args.party));
  const recipe = parseRecipe(asString(args.recipe));
  const placement = parsePlacement(asString(args.placement));
  const out = parseOut(asString(args.out));

  const input = buildLabInput(seeds[0], classes, recipe, placement);
  const rows = runBatch(input, seeds, untilMs);
  writeArtifact(out, writeCsv(rows));
  writeActorsCompanion(out, rows, {
    command: 'run', hours, seeds: asString(args.seeds), recipe, placement, party: classes,
  });
  process.stdout.write(`wrote ${rows.length} row(s) to ${out}\n`);
}

function matrixCommand(args: CliArgs): void {
  const hours = parseHours(asString(args.hours));
  const untilMs = hoursToMs(hours);
  const seeds = parseSeeds(asString(args.seeds));
  const out = parseOut(asString(args.out));

  const rows = runMatrix(seeds, untilMs);
  writeArtifact(out, writeCsv(rows));
  writeActorsCompanion(out, rows, { command: 'matrix', hours, seeds: asString(args.seeds) });
  process.stdout.write(`wrote ${rows.length} row(s) to ${out}\n`);
}

async function benchmarkCommand(args: CliArgs): Promise<void> {
  const hours = parseHoursList(asString(args.hours));
  const runs = parseRuns(asString(args.runs));
  const out = parseOut(asString(args.out));

  const report = await benchmark(hours, runs);
  writeArtifact(out, writeBenchmark(report));
  process.stdout.write(`wrote benchmark report to ${out}\n`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      hours: { type: 'string' },
      seeds: { type: 'string' },
      recipe: { type: 'string' },
      party: { type: 'string' },
      placement: { type: 'string' },
      out: { type: 'string' },
      runs: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });

  switch (command) {
    case 'run':
      runCommand(values);
      return;
    case 'matrix':
      matrixCommand(values);
      return;
    case 'benchmark':
      await benchmarkCommand(values);
      return;
    default:
      throw new CliError(`unknown command "${command ?? ''}"; expected run, matrix, or benchmark`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
