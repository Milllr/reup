// What the buyer reads from its environment. Run it with: infisical run -- npm run start -w services/buyer
export interface Config {
  HUB_URL: string;
  DEVICE_TOKEN: string;
  SUPPLY_URL: string;
  TINYFISH_API_KEY: string;
  TINYFISH_PROFILE_ID: string;
  /** tinyfish, or local for the development stand in that drives the store without TinyFish. */
  ENGINE: 'tinyfish' | 'local';
  OFFCUT_EMAIL: string;
  OFFCUT_PASSWORD: string;
  TIME_ZONE: string;
  RECORDINGS_DIR: string;
}

export function configFrom(env: Record<string, string | undefined>, recordingsDir: string): Config {
  const text = (key: string, fallback: string) => (env[key] && env[key] !== '' ? (env[key] as string) : fallback);
  return {
    HUB_URL: text('HUB_URL', 'http://localhost:3000').replace(/\/$/, ''),
    DEVICE_TOKEN: text('DEVICE_TOKEN', 'dev-device-token'),
    SUPPLY_URL: text('SUPPLY_URL', 'http://localhost:3001').replace(/\/$/, ''),
    TINYFISH_API_KEY: text('TINYFISH_API_KEY', ''),
    TINYFISH_PROFILE_ID: text('TINYFISH_PROFILE_ID', ''),
    ENGINE: env.BUYER_ENGINE === 'local' ? 'local' : 'tinyfish',
    OFFCUT_EMAIL: text('OFFCUT_EMAIL', 'shop@reup.test'),
    OFFCUT_PASSWORD: text('OFFCUT_PASSWORD', ''),
    TIME_ZONE: text('TIME_ZONE', 'America/Toronto'),
    RECORDINGS_DIR: text('BUYER_RECORDINGS_DIR', recordingsDir),
  };
}

/** What to print at startup. Says whether each secret is set, never what it is. */
export function startupLines(c: Config): string[] {
  const set = (v: string) => (v !== '' ? 'set' : 'not set');
  return [
    `Hub: ${c.HUB_URL}`,
    `Store: ${c.SUPPLY_URL}`,
    `Engine: ${c.ENGINE === 'local' ? 'local stand in (development only, not the live web)' : 'TinyFish'}`,
    `TINYFISH_API_KEY: ${set(c.TINYFISH_API_KEY)}`,
    `TINYFISH_PROFILE_ID: ${set(c.TINYFISH_PROFILE_ID)}${c.TINYFISH_PROFILE_ID === '' ? ' (cart and place runs will need OFFCUT_PASSWORD to sign in)' : ''}`,
    `OFFCUT_PASSWORD: ${set(c.OFFCUT_PASSWORD)}`,
  ];
}
