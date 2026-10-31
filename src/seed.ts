import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from './db.js';
import type { Config } from './config.js';
import * as s from './schema.js';
import { DEMO_SUBJECT, type Actor } from './auth.js';
import { SOURCE_URLS, publishRuleset } from './registry.js';
import { assert } from './errors.js';
export async function provision(
  db: DB,
  subject: string,
  email: string,
  name: string,
  ruleAdmin = false,
) {
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(s.users).where(eq(s.users.subject, subject));
    const user =
      old ?? (await tx.insert(s.users).values({ subject, email, ruleAdmin }).returning())[0];
    const existing = await tx.select().from(s.members).where(eq(s.members.userId, user.id));
    if (existing.length) return { user, organizationId: existing[0].organizationId };
    const [org] = await tx.insert(s.organizations).values({ name, ownerId: user.id }).returning();
    await tx.insert(s.members).values({ organizationId: org.id, userId: user.id, role: 'owner' });
    return { user, organizationId: org.id };
  });
}
export async function seedRegistry(db: DB) {
  let [jurisdiction] = await db
    .select()
    .from(s.jurisdictions)
    .where(eq(s.jurisdictions.name, 'City of Brentwood, California'));
  if (!jurisdiction)
    [jurisdiction] = await db
      .insert(s.jurisdictions)
      .values({ name: 'City of Brentwood, California', agency: 'City of Brentwood' })
      .returning();
  let [profile] = await db
    .select()
    .from(s.profiles)
    .where(eq(s.profiles.jurisdictionId, jurisdiction.id));
  if (!profile)
    [profile] = await db
      .insert(s.profiles)
      .values({
        jurisdictionId: jurisdiction.id,
        permitType: 'Res New',
        displayName: 'New accessory dwelling unit (ADU) — Res New',
        applicability: { projectType: 'new_adu' },
        version: 'candidate-v1',
      })
      .returning();
  for (const officialUrl of SOURCE_URLS) {
    const snapshot =
      'CANDIDATE URL ONLY. No official source text has been verified or ingested. This record does not establish a government requirement.';
    await db
      .insert(s.sources)
      .values({
        officialUrl,
        jurisdictionId: jurisdiction.id,
        agency: officialUrl.includes('hcd.ca.gov') ? 'California HCD' : 'City of Brentwood',
        title: 'Unverified candidate source URL',
        documentType: 'html',
        checksum: createHash('sha256').update(snapshot).digest('hex'),
        snapshot,
      })
      .onConflictDoNothing();
  }
  return { jurisdiction, profile };
}
export async function seedDemo(db: DB, c: Config) {
  assert(
    c.DEMO_MODE && c.NODE_ENV !== 'production',
    403,
    'DEMO_DISABLED',
    'Synthetic data requires explicit non-production demo mode',
  );
  const identity = await provision(
    db,
    DEMO_SUBJECT,
    'synthetic@example.invalid',
    'SYNTHETIC Demo Organization',
    true,
  );
  const actor: Actor = {
    userId: identity.user.id,
    organizationId: identity.organizationId,
    role: 'owner',
    ruleAdmin: true,
  };
  const { jurisdiction, profile } = await seedRegistry(db);
  const [existing] = await db
    .select()
    .from(s.rulesets)
    .where(eq(s.rulesets.version, 'SYNTHETIC-1'));
  if (existing) return { actor, jurisdiction, profile, ruleset: existing };
  const descriptions = [
    'SYNTHETIC RULE: Include a building permit application.',
    'SYNTHETIC RULE: Include an architectural plan set.',
    'SYNTHETIC RULE: Include a supporting certification at application.',
    'SYNTHETIC RULE: Supply an owner name.',
    'SYNTHETIC RULE: For an attached ADU include an ownership declaration.',
    'SYNTHETIC RULE: Supply an ownership declaration before issuance.',
    'SYNTHETIC RULE: Supply a project description.',
  ];
  const snapshot =
    'SYNTHETIC DEMONSTRATION REQUIREMENTS. These are fictional test rules and are not City of Brentwood requirements.\n' +
    descriptions.join('\n');
  const checksum = createHash('sha256').update(snapshot).digest('hex');
  const [source] = await db
    .insert(s.sources)
    .values({
      agency: 'FICTIONAL TEST AGENCY',
      officialUrl: 'synthetic://permitproof/rules/v1',
      title: 'SYNTHETIC fixture rules — no government authority',
      documentType: 'fixture',
      jurisdictionId: jurisdiction.id,
      snapshot,
      checksum,
      synthetic: true,
      verificationStatus: 'verified',
      verifiedBy: actor.userId,
      retrievedAt: new Date(),
      lastVerifiedAt: new Date(),
    })
    .returning();
  const matching = [
    { kind: 'document_type', documentType: 'building_permit_application' },
    { kind: 'document_type', documentType: 'architectural_plan_set' },
    { kind: 'document_type', documentType: 'supporting_certification' },
    { kind: 'field', field: 'ownerName' },
    { kind: 'document_type', documentType: 'ownership_declaration' },
    { kind: 'document_type', documentType: 'ownership_declaration' },
    { kind: 'field', field: 'projectDescription' },
  ];
  const ids = [];
  for (let i = 0; i < descriptions.length; i++) {
    const [r] = await db
      .insert(s.requirements)
      .values({
        sourceId: source.id,
        sourceVersion: checksum,
        profileId: profile.id,
        description: descriptions[i],
        applicability: i === 4 ? { aduType: 'attached' } : {},
        stage: i === 5 ? 'issuance' : 'application',
        severity: 'warning',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        verifiedBy: actor.userId,
        matching: matching[i],
        excerpt: descriptions[i],
        location: `Synthetic fixture line ${i + 2}`,
        effectiveFrom: '2026-01-01',
      })
      .returning();
    ids.push(r.id);
  }
  const ruleset = await publishRuleset(db, c, actor, {
    profileId: profile.id,
    version: 'SYNTHETIC-1',
    requirementIds: ids,
    effectiveFrom: '2026-01-01',
  });
  return { actor, jurisdiction, profile, ruleset };
}
