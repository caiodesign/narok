import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
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
