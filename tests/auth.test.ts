import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWTPayload } from 'jose';
import type { FastifyRequest } from 'fastify';
import { authenticate } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/db.js';
import { provision } from '../src/seed.js';
let keyset: any;
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, createRemoteJWKSet: () => actual.createLocalJWKSet(keyset) };
});
let db: Awaited<ReturnType<typeof connectDatabase>>;
let identity: Awaited<ReturnType<typeof provision>>;
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let auth: ReturnType<typeof authenticate>;
beforeAll(async () => {
  pair = await generateKeyPair('RS256');
  keyset = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'synthetic-test-key', alg: 'RS256' }],
  };
  const c = loadConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'false',
    OIDC_ISSUER: 'https://synthetic-issuer.example.invalid',
    OIDC_AUDIENCE: 'permitproof-test',
    OIDC_JWKS_URL: 'https://synthetic-issuer.example.invalid/jwks',
    PGLITE_PATH: ':memory:',
  });
  db = await connectDatabase(c);
  await db.migrate();
  identity = await provision(db.db, 'synthetic-user', 'test@example.invalid', 'SYNTHETIC auth org');
  auth = authenticate(db.db, c);
});
afterAll(async () => db.close());
async function jwt(overrides: JWTPayload = {}) {
  return new SignJWT({
    iss: 'https://synthetic-issuer.example.invalid',
    aud: 'permitproof-test',
    sub: 'synthetic-user',
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-test-key' })
    .sign(pair.privateKey);
}
async function request(token: string, organizationId = identity.organizationId) {
  const req = {
    headers: { authorization: `Bearer ${token}`, 'x-organization-id': organizationId },
  } as FastifyRequest;
  await auth(req);
  return req.actor;
}
it('verifies a signed OIDC token and resolves server-owned membership', async () => {
  expect((await request(await jwt())).userId).toBe(identity.user.id);
});
it('rejects expired, missing-expiry, wrong-audience, wrong-issuer and altered tokens', async () => {
  for (const payload of [
    { exp: 1 },
    { exp: undefined },
    { aud: 'other' },
    { iss: 'https://evil.example.invalid' },
  ])
    await expect(request(await jwt(payload))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  const value = await jwt();
  await expect(request(value.slice(0, -8) + 'invalidx')).rejects.toMatchObject({
    code: 'UNAUTHENTICATED',
  });
});
it('rejects unprovisioned identities and unauthorized organizations', async () => {
  await expect(request(await jwt({ sub: 'unknown' }))).rejects.toMatchObject({
    code: 'NOT_PROVISIONED',
  });
  await expect(request(await jwt(), '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});
