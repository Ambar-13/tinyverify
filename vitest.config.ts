import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  // Read in Node, then passed to the Worker runtime as a binding.
  const migrations = await readD1Migrations('./migrations');

  return {
    plugins: [
      cloudflareTest({
        // A small entry for the pool, so the app's modules load inside each test file and vi.mock still applies.
        main: './tests/worker-stub.ts',
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            HOOK_SECRET: 'test-hook-secret',
            OWN_KEY_SECRET: 'test-own-key-secret',
            TINYFISH_API_KEY: 'test-tinyfish-key',
            ADMIN_KEY: 'test-admin-key',
            API_KEYS: 'test-api-key',
            PUBLIC_DAILY_CENTS: '200',
            JUDGE_DAILY_CENTS: '500',
            OPS_DAILY_CENTS: '200',
            CEILING_CENTS: '5000',
            WALLET_FLOOR_CENTS: '300',
            BASE_URL: 'https://replace-after-deploy.workers.dev',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./tests/setup.ts'],
    },
  };
});
