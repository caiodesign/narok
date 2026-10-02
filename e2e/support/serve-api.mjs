/**
 * Playwright's `webServer` for the real API (milestone B Task 11, gate B-24).
 *
 * Recreates the harness database `narok_e2e` from the committed migrations,
 * then runs `apps/server` against it and stays in the foreground until
 * Playwright stops it. The development database is never touched.
 *
 * Usage: node e2e/support/serve-api.mjs <port> <origin>
 */
import { prepareDatabase, startServer } from './server.mjs';

const port = Number(process.argv[2] ?? 8787);
const origin = process.argv[3] ?? 'http://127.0.0.1:4173';

const url = await prepareDatabase('narok_e2e');
const server = await startServer({ url, port, origin, log: (line) => console.log(line) });

const stop = () => {
  void server.kill().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const { code } = await server.exited;
process.exit(code ?? 1);
