import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/artifacts/**',
      '**/dist/**',
      '**/e2e/**',
    ],
  },
  ...tseslint.configs.recommended,
);
