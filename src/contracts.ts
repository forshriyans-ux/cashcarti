import { z } from 'zod';
export const categories = [
  'Verified present',
  'Potentially missing',
  'Inconsistent information',
  'Needs human review',
  'Not applicable',
  'Unable to determine',
] as const;
export const documentTypes = [
  'building_permit_application',
  'architectural_plan_set',
  'site_plan',
  'ownership_declaration',
  'supporting_certification',
  'other',
  'unknown',
] as const;
export const factFields = [
  'projectAddress',
  'ownerName',
  'applicantName',
  'projectDescription',
  'aduType',
  'proposedSize',
  'contractor',
  'sheetIdentifier',
  'date',
  'signature',
] as const;
export const spanSchema = z
  .object({
    documentId: z.string().uuid(),
    pageNumber: z.number().int().positive(),
    text: z.string().min(1).max(3000),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
export type Span = z.infer<typeof spanSchema>;
export const factSchema = z
  .object({
    field: z.enum(factFields),
    value: z.string().max(1000),
    evidence: spanSchema,
    method: z.enum(['deterministic', 'ai']).optional(),
  })
  .strict();
export type Fact = z.infer<typeof factSchema>;
export const classificationSchema = z
  .object({
    type: z.enum(documentTypes),
    evidence: z.array(spanSchema).max(5),
    method: z.enum(['deterministic', 'ai', 'unknown']),
  })
  .strict();
export type Classification = z.infer<typeof classificationSchema>;
export const conditionsSchema = z
  .object({ aduType: z.enum(['attached', 'detached', 'conversion']).optional() })
  .strict();
export const matchSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('document_type'),
      documentType: z.enum(documentTypes).refine((v) => v !== 'unknown'),
    })
    .strict(),
  z.object({ kind: z.literal('field'), field: z.enum(factFields) }).strict(),
  z.object({ kind: z.literal('semantic') }).strict(),
]);
export const ruleSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceVersion: z.string(),
  sourceUrl: z.string(),
  sourceTitle: z.string(),
  description: z.string(),
  applicability: conditionsSchema,
  stage: z.enum(['application', 'review', 'issuance', 'other']),
  severity: z.enum(['info', 'warning', 'high']),
  matching: matchSchema,
  excerpt: z.string().min(1),
  location: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  verifiedAt: z.string().optional(),
  sourceVerifiedAt: z.string().optional(),
  sourceRetrievedAt: z.string().optional(),
});
export type Rule = z.infer<typeof ruleSchema>;
export type Page = {
  documentId: string;
  pageNumber: number;
  text: string;
  status: string;
  method: string;
};
export type ReviewDocument = {
  id: string;
  filename: string;
  extractionStatus: string;
  classification: Classification;
  facts: Fact[];
  pages: Page[];
};
export type FindingResult = {
  requirementId?: string;
  category: (typeof categories)[number];
  severity: string;
  explanation: string;
  suggestedAction: string;
  evidence: Span[];
  interpretation: 'deterministic' | 'ai';
  sourceId?: string;
};
export const findingResultSchema = z
  .object({
    requirementId: z.string().uuid().optional(),
    category: z.enum(categories),
    severity: z.string(),
    explanation: z.string(),
    suggestedAction: z.string(),
    evidence: z.array(spanSchema),
    interpretation: z.enum(['deterministic', 'ai']),
    sourceId: z.string().uuid().optional(),
  })
  .strict();
export const reportSchema = z.object({
  schemaVersion: z.literal('1'),
  reviewId: z.string().uuid(),
  project: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      filingDate: z.string(),
      address: z.string().nullable(),
    })
    .passthrough(),
  jurisdiction: z.string(),
  permitCategory: z.string(),
  reviewDate: z.string(),
  rulesetVersion: z.string(),
  synthetic: z.boolean(),
  requirements: z.array(ruleSchema),
  findings: z.array(findingResultSchema),
  summary: z.record(z.string(), z.number()),
  documents: z.array(
    z.object({
      id: z.string().uuid(),
      filename: z.string(),
      extractionStatus: z.string(),
      classification: classificationSchema,
      pages: z.array(z.object({ pageNumber: z.number(), status: z.string(), method: z.string() })),
    }),
  ),
  ai: z.object({
    configured: z.boolean(),
    used: z.boolean(),
    model: z.string().nullable(),
    warnings: z.array(z.string()),
  }),
  limitations: z.string(),
});
export type ReviewReport = z.infer<typeof reportSchema>;
export const projectInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    projectType: z.literal('new_adu').default('new_adu'),
    jurisdictionId: z.string().uuid(),
    permitProfileId: z.string().uuid(),
    address: z.string().trim().max(300).optional(),
    filingDate: z.string().date(),
  })
  .strict();
export const projectPatch = projectInput
  .pick({ name: true, address: true, filingDate: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const pagination = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
export type ProjectInput = z.input<typeof projectInput>;
export const LIMITATION =
  'AI-assisted preparation tool for document completeness and consistency. This report does not establish legal compliance, structural safety, official government approval, or guaranteed permit acceptance, and does not replace official review or qualified professional judgment.';
export type ReviewStage =
  | 'queued'
  | 'extracting'
  | 'classifying'
  | 'checking_requirements'
  | 'generating_findings'
  | 'completed'
  | 'failed';
