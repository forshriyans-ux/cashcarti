import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
const id = () => uuid('id').primaryKey().defaultRandom();
const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  subject: text('subject').notNull().unique(),
  ruleAdmin: boolean('rule_admin').notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
});
export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: created(),
});
export const members = pgTable(
  'organization_members',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
  },
  (t) => [uniqueIndex('member_unique').on(t.organizationId, t.userId)],
);
export const jurisdictions = pgTable('jurisdictions', {
  id: id(),
  name: text('name').notNull().unique(),
  agency: text('agency').notNull(),
});
export const profiles = pgTable('permit_profiles', {
  id: id(),
  jurisdictionId: uuid('jurisdiction_id')
    .notNull()
    .references(() => jurisdictions.id),
  permitType: text('permit_type').notNull(),
  displayName: text('display_name').notNull(),
  applicability: jsonb('applicability').notNull(),
  version: text('version').notNull(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
});
export const projects = pgTable(
  'projects',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    projectType: text('project_type').notNull(),
    jurisdictionId: uuid('jurisdiction_id')
      .notNull()
      .references(() => jurisdictions.id),
    permitProfileId: uuid('permit_profile_id')
      .notNull()
      .references(() => profiles.id),
    address: text('address'),
    filingDate: text('filing_date').notNull(),
    status: text('status').notNull().default('draft'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('project_tenant').on(t.organizationId)],
);
export const documents = pgTable(
  'uploaded_documents',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    checksum: text('checksum').notNull(),
    uploadStatus: text('upload_status').notNull().default('stored'),
    extractionStatus: text('extraction_status').notNull().default('queued'),
    classification: jsonb('classification'),
    facts: jsonb('facts'),
    errorCode: text('error_code'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('document_dedup').on(t.projectId, t.checksum),
    index('document_project').on(t.projectId),
  ],
);
export const pages = pgTable(
  'document_pages',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    pageIndex: integer('page_index').notNull(),
    text: text('text').notNull(),
    method: text('method').notNull(),
    status: text('status').notNull(),
    layout: jsonb('layout'),
  },
  (t) => [uniqueIndex('document_page').on(t.documentId, t.pageIndex)],
);
export const sources = pgTable(
  'official_sources',
  {
    id: id(),
    agency: text('agency').notNull(),
    officialUrl: text('official_url').notNull(),
    title: text('title').notNull(),
    documentType: text('document_type').notNull(),
    jurisdictionId: uuid('jurisdiction_id')
      .notNull()
      .references(() => jurisdictions.id),
    effectiveDate: text('effective_date'),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    checksum: text('checksum').notNull(),
    verificationStatus: text('verification_status').notNull().default('candidate'),
    snapshot: text('snapshot').notNull(),
    synthetic: boolean('synthetic').notNull().default(false),
    verifiedBy: uuid('verified_by').references(() => users.id),
  },
  (t) => [uniqueIndex('source_version').on(t.officialUrl, t.checksum)],
);
export const requirements = pgTable('permit_requirements', {
  id: id(),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => sources.id),
  sourceVersion: text('source_version').notNull(),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id),
  description: text('description').notNull(),
  applicability: jsonb('applicability').notNull(),
  stage: text('stage').notNull(),
  severity: text('severity').notNull(),
  verificationStatus: text('verification_status').notNull().default('draft'),
  matching: jsonb('matching').notNull(),
  excerpt: text('excerpt').notNull(),
  location: text('location').notNull(),
  effectiveFrom: text('effective_from').notNull(),
  effectiveTo: text('effective_to'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedBy: uuid('verified_by').references(() => users.id),
});
export const rulesets = pgTable(
  'rulesets',
  {
    id: id(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id),
    version: text('version').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    effectiveTo: text('effective_to'),
    snapshot: jsonb('snapshot').notNull(),
    synthetic: boolean('synthetic').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: created(),
  },
  (t) => [uniqueIndex('ruleset_version').on(t.profileId, t.version)],
);
export const reviews = pgTable(
  'review_runs',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('queued'),
    stage: text('stage').notNull().default('queued'),
    rulesetId: uuid('ruleset_id')
      .notNull()
      .references(() => rulesets.id),
    rulesetVersion: text('ruleset_version').notNull(),
    model: text('model'),
    inputSnapshot: jsonb('input_snapshot').notNull(),
    resultSnapshot: jsonb('result_snapshot'),
    inputHash: text('input_hash').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorCode: text('error_code'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('review_dedup').on(t.projectId, t.inputHash),
    index('review_project').on(t.projectId),
  ],
);
export const findings = pgTable('findings', {
  id: id(),
  reviewId: uuid('review_id')
    .notNull()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  requirementId: uuid('requirement_id').references(() => requirements.id),
  category: text('category').notNull(),
  severity: text('severity').notNull(),
  status: text('status').notNull(),
  explanation: text('explanation').notNull(),
  suggestedAction: text('suggested_action').notNull(),
  confidenceMetadata: jsonb('confidence_metadata'),
  interpretation: text('interpretation').notNull(),
});
export const evidence = pgTable('evidence', {
  id: id(),
  findingId: uuid('finding_id')
    .notNull()
    .references(() => findings.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
  pageNumber: integer('page_number'),
  textSpan: text('text_span'),
  start: integer('start'),
  end: integer('end'),
  officialSourceId: uuid('official_source_id').references(() => sources.id),
  requirementId: uuid('requirement_id').references(() => requirements.id),
});
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    kind: text('kind').notNull(),
    targetId: uuid('target_id').notNull(),
    dedupKey: text('dedup_key').notNull().unique(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseToken: uuid('lease_token'),
    errorCode: text('error_code'),
    createdAt: created(),
  },
  (t) => [index('jobs_claim').on(t.status, t.availableAt)],
);
export const audits = pgTable(
  'audit_events',
  {
    id: id(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    action: text('action').notNull(),
    targetId: text('target_id').notNull(),
    metadata: jsonb('metadata').notNull(),
    createdAt: created(),
  },
  (t) => [index('audit_tenant').on(t.organizationId, t.createdAt)],
);
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    cacheKey: text('cache_key').notNull(),
    model: text('model').notNull(),
    response: jsonb('response'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costMicrousd: integer('cost_microusd'),
    status: text('status').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('ai_cache').on(t.organizationId, t.cacheKey),
    index('ai_budget').on(t.organizationId, t.createdAt),
  ],
);
