// What the store reads from its environment. Real values are Wrangler secrets, pushed from Infisical.
export interface Config {
  HUB_URL: string;
  SUPPLY_WEBHOOK_SECRET: string;
  ACCOUNT_EMAIL: string;
  ACCOUNT_PASSWORD: string;
  ADMIN_PASSWORD: string;
  SHIP_DELAY_MS: number;
  TIME_ZONE: string;
}

export const DEFAULTS: Config = {
  HUB_URL: 'http://localhost:3000',
  SUPPLY_WEBHOOK_SECRET: 'dev-supply-secret',
  ACCOUNT_EMAIL: 'shop@reup.test',
  ACCOUNT_PASSWORD: 'dev-shop-password',
  ADMIN_PASSWORD: 'dev-admin-password',
  SHIP_DELAY_MS: 20_000,
  TIME_ZONE: 'America/Toronto',
};

export function configFrom(env: Record<string, unknown>): Config {
  const text = (key: Exclude<keyof Config, 'SHIP_DELAY_MS'>) => (typeof env[key] === 'string' && env[key] !== '' ? (env[key] as string) : DEFAULTS[key]);
  const delay = Number(env.SHIP_DELAY_MS);
  return {
    HUB_URL: text('HUB_URL').replace(/\/$/, ''),
    SUPPLY_WEBHOOK_SECRET: text('SUPPLY_WEBHOOK_SECRET'),
    ACCOUNT_EMAIL: text('ACCOUNT_EMAIL'),
    ACCOUNT_PASSWORD: text('ACCOUNT_PASSWORD'),
    ADMIN_PASSWORD: text('ADMIN_PASSWORD'),
    SHIP_DELAY_MS: Number.isFinite(delay) && delay >= 0 && env.SHIP_DELAY_MS !== undefined && env.SHIP_DELAY_MS !== '' ? delay : DEFAULTS.SHIP_DELAY_MS,
    TIME_ZONE: text('TIME_ZONE'),
  };
}
