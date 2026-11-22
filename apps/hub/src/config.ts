// What the hub reads from its environment. Real values come from Wrangler secrets (pushed from Infisical).
import { Supplier } from '@reup/contracts';
import { z } from 'zod';
export interface Config {
  DEVICE_TOKEN: string;
  OPS_TOKEN: string;
  APPROVE_KEY: string;
  /**
   * True: anything a person does with the approve key needs no key at all. Saying yes to an order, naming a new part
   * and changing an item then work from any screen that opens the site. Offcut Supply is a demo store and no money
   * moves, and the spend caps still hold. Operator and device routes keep their tokens.
   */
  APPROVE_OPEN: boolean;
  SUPPLY_WEBHOOK_SECRET: string;
  SUPPLY_URL: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  ORDER_CAP_CAD: number;
  DAY_CAP_CAD: number;
  /** IANA zone for "a day" in history and for weekday names. */
  TIME_ZONE: string;
  /** Live retailers for price checks. Empty means the two in seed.ts. */
  MARKET_SUPPLIERS: Supplier[];
}

export const DEFAULTS: Config = {
  DEVICE_TOKEN: 'dev-device-token',
  OPS_TOKEN: 'dev-ops-token',
  APPROVE_KEY: 'dev-approve-key',
  APPROVE_OPEN: false,
  SUPPLY_WEBHOOK_SECRET: 'dev-supply-secret',
  SUPPLY_URL: 'http://localhost:3001',
  GEMINI_API_KEY: '',
  // Asked in this order until one answers. See GeminiNamer.
  GEMINI_MODEL: 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.8-flash',
  ORDER_CAP_CAD: 150,
  DAY_CAP_CAD: 400,
  TIME_ZONE: 'America/Toronto',
  MARKET_SUPPLIERS: [],
};

export function configFrom(env: Record<string, unknown>): Config {
  type TextKey = 'DEVICE_TOKEN' | 'OPS_TOKEN' | 'APPROVE_KEY' | 'SUPPLY_WEBHOOK_SECRET' | 'SUPPLY_URL' | 'GEMINI_MODEL' | 'TIME_ZONE';
  const text = (key: TextKey) => (typeof env[key] === 'string' && env[key] !== '' ? (env[key] as string) : DEFAULTS[key]);
  const num = (key: 'ORDER_CAP_CAD' | 'DAY_CAP_CAD') => {
    const n = Number(env[key]);
    return Number.isFinite(n) && n > 0 ? n : DEFAULTS[key];
  };
  return {
    DEVICE_TOKEN: text('DEVICE_TOKEN'),
    OPS_TOKEN: text('OPS_TOKEN'),
    APPROVE_KEY: text('APPROVE_KEY'),
    APPROVE_OPEN: env.APPROVE_OPEN === true || env.APPROVE_OPEN === 'true',
    SUPPLY_WEBHOOK_SECRET: text('SUPPLY_WEBHOOK_SECRET'),
    SUPPLY_URL: text('SUPPLY_URL').replace(/\/$/, ''),
    GEMINI_API_KEY: typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY : '',
    GEMINI_MODEL: text('GEMINI_MODEL'),
    ORDER_CAP_CAD: num('ORDER_CAP_CAD'),
    DAY_CAP_CAD: num('DAY_CAP_CAD'),
    TIME_ZONE: text('TIME_ZONE'),
    MARKET_SUPPLIERS: market(env.MARKET_SUPPLIERS),
  };
}

function market(raw: unknown): Supplier[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    return z.array(Supplier).parse(JSON.parse(raw)).filter((s) => s.kind === 'market');
  } catch {
    console.error('MARKET_SUPPLIERS is not a valid JSON array of Supplier. Using the seed list.');
    return [];
  }
}
