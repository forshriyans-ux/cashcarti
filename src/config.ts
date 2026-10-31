import 'dotenv/config';
import { z } from 'zod';
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().optional(),
  PGLITE_PATH: z.string().default('./data/database'),
  DEMO_MODE: bool.default(false),
  DEMO_TOKEN: z.string().min(32).optional(),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_JWKS_URL: z.string().url().optional(),
  CORS_ORIGIN: z.string().url().optional(),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_PATH: z.string().default('./data/private'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-west-2'),
  S3_ENDPOINT: z.string().url().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(25),
  MAX_PAGES: z.coerce.number().int().min(1).max(200).default(60),
  MAX_PROJECT_DOCUMENTS: z.coerce.number().int().min(1).max(100).default(20),
  RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  OCR_ENABLED: bool.default(true),
  CLAMAV_ENABLED: bool.default(false),
  WORKER_ENABLED: bool.default(true),
  AI_ENABLED: bool.default(false),
  AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gpt-4.1-mini'),
  AI_DAILY_CALL_LIMIT: z.coerce.number().int().min(0).default(30),
  AI_INPUT_PRICE_PER_MILLION: z.coerce.number().min(0).optional(),
  AI_OUTPUT_PRICE_PER_MILLION: z.coerce.number().min(0).optional(),
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = configSchema.parse(env);
  if (c.DEMO_MODE && !c.DEMO_TOKEN)
    throw new Error('DEMO_TOKEN of at least 32 characters is required');
  if (
    c.NODE_ENV === 'production' &&
    (!c.DATABASE_URL || c.DEMO_MODE || !c.OIDC_ISSUER || !c.OIDC_AUDIENCE || !c.OIDC_JWKS_URL)
  )
    throw new Error('Production requires PostgreSQL and OIDC; demo mode is prohibited');
  if (!c.DEMO_MODE && (!c.OIDC_ISSUER || !c.OIDC_AUDIENCE || !c.OIDC_JWKS_URL))
    throw new Error('Configure OIDC or explicitly enable demo mode');
  if (c.OIDC_JWKS_URL && new URL(c.OIDC_JWKS_URL).protocol !== 'https:')
    throw new Error('OIDC JWKS requires HTTPS');
  if (c.STORAGE_DRIVER === 's3' && !c.S3_BUCKET) throw new Error('S3_BUCKET required');
  if (c.AI_ENABLED && !c.AI_API_KEY) throw new Error('AI_API_KEY required for AI_ENABLED');
  if (c.AI_ENABLED && new URL(c.AI_BASE_URL).protocol !== 'https:')
    throw new Error('AI provider requires HTTPS');
  return c;
}
