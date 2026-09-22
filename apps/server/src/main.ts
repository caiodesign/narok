/**
 * The process entry point. Everything it does is read the environment, build
 * the app from `createApp`, and listen: no rule lives here, so a test never
 * needs to start a process to exercise one.
 */
import { createApp } from './app';
import { defaultConfig, type ServerConfig } from './config';

function fromEnvironment(): ServerConfig {
  const base = defaultConfig();
  const origins = process.env.NAROK_ALLOWED_ORIGINS;
  return {
    ...base,
    allowedOrigins: origins === undefined ? base.allowedOrigins : origins.split(',').map((value) => value.trim()),
    secureCookies: process.env.NAROK_INSECURE_COOKIES !== '1',
  };
}

const port = Number(process.env.PORT ?? 8080);
const app = await createApp({ config: fromEnvironment(), onLog: (line) => console.log(line) });
await app.listen({ port, host: '127.0.0.1' });
console.log(`narok-server listening on ${port}`);
