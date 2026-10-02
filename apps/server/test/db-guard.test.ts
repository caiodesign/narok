/**
 * Ruling R204: the db suites truncate every table, so they refuse the dev
 * database `narok` unless GitHub Actions or an explicit, named opt-in says otherwise.
 */
import { describe, expect, test } from 'vitest';
import { assertDisposableDatabase } from './db-helpers';

const url = (name: string) => `postgres://narok:narok@127.0.0.1:5433/${name}`;

describe('the db suites never truncate the dev database by default', () => {
  test('the dev database is refused with no opt-in', () => {
    expect(() => assertDisposableDatabase(url('narok'), {})).toThrow(/refusing to run the db suites against database "narok"/);
    expect(() => assertDisposableDatabase(url('narok'), { CI: 'true' })).toThrow();
    expect(() => assertDisposableDatabase(url('narok'), { GITHUB_ACTIONS: 'false' })).toThrow();
  });

  test('a test or harness database is allowed', () => {
    expect(() => assertDisposableDatabase(url('narok_e2e'), {})).not.toThrow();
    expect(() => assertDisposableDatabase(url('narok_test'), {})).not.toThrow();
  });

  test('GitHub Actions, or an opt-in naming that exact database, allows it', () => {
    expect(() => assertDisposableDatabase(url('narok'), { GITHUB_ACTIONS: 'true' })).not.toThrow();
    expect(() => assertDisposableDatabase(url('narok'), { NAROK_DB_TESTS_TRUNCATE: 'narok' })).not.toThrow();
    expect(() => assertDisposableDatabase(url('narok'), { NAROK_DB_TESTS_TRUNCATE: 'other' })).toThrow();
  });
});
