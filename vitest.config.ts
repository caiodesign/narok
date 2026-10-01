import { defineConfig } from 'vitest/config';

/**
 * Two projects, because they need different isolation.
 *
 * `unit` is everything pure: files run in parallel, which is why the suite
 * finishes in seconds.
 *
 * `db` is the suites that talk to PostgreSQL. They share one database and each
 * truncates between cases, so running their *files* in parallel makes them
 * truncate each other's rows mid-assertion — which showed up as every suite
 * failing together while each passed alone. One worker with no file parallelism
 * serialises the files
 * and keeps the truncation honest.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/test/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/.claude/**', '**/artifacts/**', '**/e2e/**', '**/*.db.test.ts'],
        },
      },
      {
        test: {
          name: 'db',
          include: ['**/test/**/*.db.test.ts'],
          exclude: ['**/node_modules/**', '**/.claude/**', '**/artifacts/**', '**/e2e/**'],
          pool: 'forks',
          // Vitest 4 removed `poolOptions.forks.singleFork`; one worker and no
          // file parallelism is its replacement (the v4 pool-rework guide).
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
    ],
  },
});
