/** The Worker's bindings: the D1 database, the secrets, and the plain settings from wrangler.toml. */

export type Env = {
  DB: D1Database;
  TINYFISH_API_KEY: string;
  HOOK_SECRET: string;
  /** Seals a visitor's own TinyFish key while their lookup runs. Unset means that option is switched off. */
  OWN_KEY_SECRET?: string;
  ADMIN_KEY: string;
  API_KEYS: string;
  PUBLIC_DAILY_CENTS: string;
  JUDGE_DAILY_CENTS: string;
  OPS_DAILY_CENTS: string;
  CEILING_CENTS: string;
  WALLET_FLOOR_CENTS: string;
  BASE_URL: string;
  /** "on" when the TinyFish account has custom max steps; anything else means it does not. */
  AGENT_STEP_CAP?: string;
};
