import { createRemoteJWKSet, jwtVerify } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { users, members } from './schema.js';
import { assert } from './errors.js';
export const DEMO_SUBJECT = 'permitproof:synthetic-demo';
export type Actor = { userId: string; organizationId: string; role: string; ruleAdmin: boolean };
declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}
export function authenticate(db: DB, c: Config) {
  const jwks = c.OIDC_JWKS_URL
    ? createRemoteJWKSet(new URL(c.OIDC_JWKS_URL), { timeoutDuration: 5000 })
    : null;
  return async (request: FastifyRequest) => {
    const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    assert(bearer, 401, 'UNAUTHENTICATED', 'Bearer authentication is required');
    let subject: string | undefined;
    if (c.DEMO_MODE) {
      const a = Buffer.from(bearer),
        b = Buffer.from(c.DEMO_TOKEN!);
      assert(
        a.length === b.length && timingSafeEqual(a, b),
        401,
        'UNAUTHENTICATED',
        'Invalid credentials',
      );
      subject = DEMO_SUBJECT;
    } else {
      try {
        const { payload } = await jwtVerify(bearer, jwks!, {
          issuer: c.OIDC_ISSUER,
          audience: c.OIDC_AUDIENCE,
          algorithms: ['RS256', 'ES256'],
          requiredClaims: ['sub', 'exp'],
        });
        subject = payload.sub;
      } catch {
        assert(false, 401, 'UNAUTHENTICATED', 'Invalid or expired credentials');
      }
    }
    assert(subject, 401, 'UNAUTHENTICATED', 'Identity subject is required');
    const [u] = await db.select().from(users).where(eq(users.subject, subject));
    assert(u, 403, 'NOT_PROVISIONED', 'Identity has not been provisioned');
    const organization = request.headers['x-organization-id'];
    assert(
      typeof organization === 'string' && /^[a-f0-9-]{36}$/i.test(organization),
      400,
      'ORGANIZATION_REQUIRED',
      'Send x-organization-id',
    );
    const [m] = await db
      .select()
      .from(members)
      .where(and(eq(members.userId, u.id), eq(members.organizationId, organization)));
    assert(m, 404, 'NOT_FOUND', 'Organization not found');
    request.actor = {
      userId: u.id,
      organizationId: m.organizationId,
      role: m.role,
      ruleAdmin: u.ruleAdmin,
    };
  };
}
export function requireAdmin(actor: Actor) {
  assert(
    actor.role === 'owner' || actor.role === 'admin',
    403,
    'FORBIDDEN',
    'Administrator access required',
  );
}
export function requireRuleAdmin(actor: Actor) {
  assert(actor.ruleAdmin, 403, 'FORBIDDEN', 'Global government-rule administrator access required');
}
