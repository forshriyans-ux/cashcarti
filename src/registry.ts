import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { load } from 'cheerio';
import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import type { Actor } from './auth.js';
import { sources, requirements, rulesets, profiles, audits } from './schema.js';
import { ruleSchema, matchSchema, conditionsSchema } from './contracts.js';
import { assert, AppError } from './errors.js';
export const SOURCE_URLS = [
  'https://www.brentwoodca.gov/government/community-development/development-services/accessory-dwelling-units',
  'https://www.brentwoodca.gov/government/community-development/development-services/ab-2234-post-entitlement-phase-permits',
  'https://www.brentwoodca.gov/government/community-development/development-services/electronic-submittal-portal',
  'https://www.brentwoodca.gov/government/community-development/building/forms-handouts',
  'https://www.hcd.ca.gov/building-standards/adu',
];
export function sourceUrl(value: string) {
  const url = new URL(value);
  assert(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ['www.brentwoodca.gov', 'www.hcd.ca.gov'].includes(url.hostname),
    400,
    'SOURCE_URL',
    'Only approved HTTPS government source domains are supported',
  );
  assert(!url.hash, 400, 'SOURCE_URL', 'Use source location separately from the URL');
  return url.href;
}
// Bounded, no redirects, no crawling. DNS is constrained by the deployment egress policy.
export async function retrieveSource(url: string) {
  sourceUrl(url);
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'text/html', 'user-agent': 'PermitProof-SourceVerifier/0.1' },
  });
  assert(
    response.ok,
    422,
    'SOURCE_FETCH_FAILED',
    `Official source returned HTTP ${response.status}; no rules were activated`,
  );
  assert(
    response.headers.get('content-type')?.includes('text/html'),
    415,
    'SOURCE_FORMAT',
    'Automated retrieval currently supports HTML only; PDFs require the manual source-snapshot workflow',
  );
  const chunks: Uint8Array[] = [];
  let size = 0;
  assert(response.body, 422, 'SOURCE_EMPTY', 'Empty official source');
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= 2_000_000, 413, 'SOURCE_SIZE', 'Source exceeds retrieval limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const $ = load(body);
  $('script,style,iframe,nav,footer').remove();
  const title = $('title').text().trim().slice(0, 300) || 'Untitled official source';
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  assert(text.length > 40, 422, 'SOURCE_EMPTY', 'No usable official source text');
  return { title, text, checksum: createHash('sha256').update(body).digest('hex') };
}
export const sourceImport = z
  .object({
    officialUrl: z.string().url(),
    title: z.string().min(1).max(300),
    agency: z.string().min(1).max(200),
    jurisdictionId: z.string().uuid(),
    documentType: z.enum(['html', 'pdf']),
    effectiveDate: z.string().date().optional(),
    snapshot: z.string().min(40).max(500000),
    attestation: z.literal(
      'I retrieved this exact text from the official URL and checked its jurisdiction and currency.',
    ),
  })
  .strict();
export const requirementInput = z
  .object({
    sourceId: z.string().uuid(),
    profileId: z.string().uuid(),
    description: z.string().min(1).max(2000),
    applicability: conditionsSchema,
    stage: z.enum(['application', 'review', 'issuance', 'other']),
    severity: z.enum(['info', 'warning', 'high']),
    matching: matchSchema,
    excerpt: z.string().min(1).max(6000),
    location: z.string().min(1).max(500),
    effectiveFrom: z.string().date(),
    effectiveTo: z.string().date().optional(),
  })
  .strict()
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    message: 'Invalid effective interval',
  });
export async function publishRuleset(
  db: DB,
  c: Config,
  actor: Actor,
  input: {
    profileId: string;
    version: string;
    requirementIds: string[];
    effectiveFrom: string;
    effectiveTo?: string;
  },
) {
  return db.transaction(async (tx) => {
    const [profile] = await tx.select().from(profiles).where(eq(profiles.id, input.profileId));
    assert(profile, 404, 'NOT_FOUND', 'Permit profile not found');
    assert(
      !input.effectiveTo || input.effectiveTo >= input.effectiveFrom,
      400,
      'DATES',
      'Invalid effective interval',
    );
    const snapshot = [];
    let synthetic = false;
    for (const id of input.requirementIds) {
      const [r] = await tx.select().from(requirements).where(eq(requirements.id, id));
      assert(
        r && r.profileId === profile.id && r.verificationStatus === 'verified',
        409,
        'UNVERIFIED_RULE',
        'Every rule must be verified and belong to the profile',
      );
      const [s] = await tx.select().from(sources).where(eq(sources.id, r.sourceId));
      assert(
        s &&
          s.verificationStatus === 'verified' &&
          s.checksum === r.sourceVersion &&
          s.snapshot.includes(r.excerpt),
        409,
        'UNVERIFIED_SOURCE',
        'Every rule must have an exact verified source excerpt',
      );
      assert(
        r.verifiedAt && r.verifiedBy && s.lastVerifiedAt && s.verifiedBy && s.retrievedAt,
        409,
        'VERIFICATION_METADATA',
        'Source and requirement must have human verification identities and timestamps',
      );
      assert(
        s.jurisdictionId === profile.jurisdictionId,
        409,
        'JURISDICTION',
        'Source and profile jurisdictions differ',
      );
      assert(
        r.effectiveFrom <= input.effectiveFrom &&
          (!r.effectiveTo || (!!input.effectiveTo && r.effectiveTo >= input.effectiveTo)),
        409,
        'DATES',
        'Rules must cover the entire ruleset filing-date interval',
      );
      assert(
        !s.synthetic || c.DEMO_MODE,
        409,
        'SYNTHETIC_RULE',
        'Synthetic rules cannot be published outside explicit demo mode',
      );
      synthetic ||= s.synthetic;
      snapshot.push(
        ruleSchema.parse({
          ...r,
          sourceUrl: s.officialUrl,
          sourceTitle: s.title,
          verifiedAt: r.verifiedAt.toISOString(),
          sourceVerifiedAt: s.lastVerifiedAt.toISOString(),
          sourceRetrievedAt: s.retrievedAt.toISOString(),
        }),
      );
    }
    assert(
      snapshot.length > 0,
      400,
      'EMPTY_RULESET',
      'At least one verified requirement is needed',
    );
    const [row] = await tx
      .insert(rulesets)
      .values({ ...input, snapshot, synthetic, createdBy: actor.userId })
      .returning();
    await tx.insert(audits).values({
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'ruleset.published',
      targetId: row.id,
      metadata: { version: row.version, count: snapshot.length },
    });
    return row;
  });
}
