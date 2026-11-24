import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', '.wrangler', 'coverage', 'tests/fixtures'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // An unused name that starts with an underscore is deliberate: a parameter kept for its position.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The page tests drive the demo page's script through a small hand-written DOM, which is loosely typed.
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
);
