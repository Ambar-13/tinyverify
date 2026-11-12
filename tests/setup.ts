import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';
import type { Env as AppEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

// Table names come from the CREATE TABLE statements in the migrations.
const tableNames = [
  ...env.TEST_MIGRATIONS.flatMap((migration) => migration.queries)
    .join('\n')
    .matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g),
].map((match) => match[1]);

beforeEach(async () => {
  // Applying is idempotent: the pool records applied migrations in d1_migrations.
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

  // D1 is not reset between tests in this pool, so clear every table for a clean start.
  await env.DB.batch(tableNames.map((name) => env.DB.prepare(`DELETE FROM ${name}`)));
});
