/**
 * The process entry point. Everything it does is read the environment, build
 * the app from `createApp`, and listen: no rule lives here, and what the
 * environment selects is decided in `compose.ts`, where a test can reach it.
 */
import { createApp } from './app';
import { compose } from './compose';

const composed = compose(process.env, (line) => console.log(line));
const port = Number(process.env.PORT ?? 8080);
const app = await createApp(composed.deps);
app.addHook('onClose', async () => {
  await composed.close();
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`narok-server listening on ${port}`);
