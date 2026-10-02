import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Ruling R197: `vite preview` forwards `/api` and `/ws` to a real server when
 * `NAROK_API_PROXY` names one, so the end-to-end specs (`e2e/hunt.spec.ts`,
 * `e2e/town.spec.ts`) drive the built bundle against `apps/server` on one
 * origin, the way Caddy fronts both in production (part 1 §1). Unset, preview
 * serves the bundle alone, exactly as before; nothing here reaches the build.
 */
const apiProxy = process.env.NAROK_API_PROXY;

export default defineConfig({
  base: './',
  plugins: [react()],
  preview:
    apiProxy === undefined || apiProxy === ''
      ? {}
      : { proxy: { '/api': { target: apiProxy }, '/ws': { target: apiProxy, ws: true } } },
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Third-party code (React, i18next, zod) in its own chunk, apart from
        // the game's: it changes on a dependency bump rather than every
        // deploy, and it keeps each chunk under the size warning without
        // raising the limit (milestone B Task 10, where the town screens' copy
        // pushed the single chunk past it).
        codeSplitting: { groups: [{ name: 'vendor', test: /[\/]node_modules[\/]/ }] },
      },
    },
  },
});
