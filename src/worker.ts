import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Service } from './service.js';
import type { DB } from './db.js';
import * as s from './schema.js';
import { classify, extract, extractFacts, verifySpan } from './extraction.js';
import { evaluate, applicability } from './engine.js';
import { interpret } from './ai.js';
import {
  classificationSchema,
  factSchema,
  ruleSchema,
  reportSchema,
  LIMITATION,
  type ReviewDocument,
  type Page,
} from './contracts.js';
import { assert, AppError } from './errors.js';
const LEASE_MS = 120000;
type Transaction = Parameters<Parameters<DB['transaction']>[0]>[0];
class Deferred extends Error {}
export class Worker {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(
    private service: Service,
    private reportError: (code: string, jobId?: string) => void = () => {},
  ) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.running) {
        this.running = true;
        this.runOne()
          .catch(() => this.reportError('WORKER_FAILED'))
          .finally(() => {
            this.running = false;
          });
      }
    }, 500);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise((r) => setTimeout(r, 25));
  }
  async runOne(): Promise<boolean> {
    const { db } = this.service;
    const token = randomUUID();
    const job = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(s.jobs)
        .where(
          or(
            and(eq(s.jobs.status, 'queued'), lte(s.jobs.availableAt, new Date())),
            and(eq(s.jobs.status, 'running'), lt(s.jobs.leaseUntil, new Date())),
          ),
        )
        .orderBy(s.jobs.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      const [claimed] = await tx
        .update(s.jobs)
        .set({
          status: 'running',
          leaseToken: token,
          leaseUntil: new Date(Date.now() + LEASE_MS),
          attempts: row.attempts + 1,
        })
        .where(eq(s.jobs.id, row.id))
        .returning();
      return claimed;
    });
    if (!job) return false;
    const heartbeat = setInterval(() => {
      void db
        .update(s.jobs)
        .set({ leaseUntil: new Date(Date.now() + LEASE_MS) })
        .where(and(eq(s.jobs.id, job.id), eq(s.jobs.leaseToken, token)))
        .catch(() => this.reportError('WORKER_HEARTBEAT_FAILED', job.id));
    }, 20000);
    const owns = async (tx: Transaction) => {
      const [row] = await tx
        .select()
        .from(s.jobs)
        .where(
          and(eq(s.jobs.id, job.id), eq(s.jobs.leaseToken, token), eq(s.jobs.status, 'running')),
        )
        .for('update');
      assert(row, 409, 'LEASE_LOST', 'Worker lease lost');
    };
    try {
      if (job.kind === 'extract') await this.processDocument(job.targetId, owns);
      else if (job.kind === 'review')
        await this.processReview(job.targetId, job.organizationId, owns);
      else if (job.kind === 'delete') {
        const [d] = await db.select().from(s.documents).where(eq(s.documents.id, job.targetId));
        if (d) {
          await this.service.storage.delete(d.storageKey);
          await db.transaction(async (tx) => {
            await owns(tx);
            await tx.delete(s.documents).where(eq(s.documents.id, d.id));
          });
        }
      } else if (job.kind === 'purge_project') {
        const pending = await db
          .select()
          .from(s.documents)
          .where(eq(s.documents.projectId, job.targetId));
        if (pending.length) throw new Deferred();
        await db.delete(s.projects).where(eq(s.projects.id, job.targetId));
      } else throw new Error('Unsupported job');
      await db
        .update(s.jobs)
        .set({ status: 'completed', leaseUntil: null, leaseToken: null, errorCode: null })
        .where(and(eq(s.jobs.id, job.id), eq(s.jobs.leaseToken, token)));
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'PROCESSING_FAILED';
      const deferred = e instanceof Deferred;
      if (!deferred) this.reportError(code, job.id);
      const terminal = !deferred && job.attempts >= 3;
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(s.jobs)
          .where(and(eq(s.jobs.id, job.id), eq(s.jobs.leaseToken, token)))
          .for('update');
        if (!current) return;
        await tx
          .update(s.jobs)
          .set({
            status: terminal ? 'failed' : 'queued',
            attempts: deferred ? Math.max(0, job.attempts - 1) : job.attempts,
            availableAt: new Date(
              Date.now() + (deferred ? 1000 : Math.min(30000, 1000 * 2 ** job.attempts)),
            ),
            leaseToken: null,
            leaseUntil: null,
            errorCode: deferred ? null : code,
          })
          .where(eq(s.jobs.id, job.id));
        if (terminal && job.kind === 'extract')
          await tx
            .update(s.documents)
            .set({ extractionStatus: 'failed', errorCode: code })
            .where(eq(s.documents.id, job.targetId));
        if (terminal && job.kind === 'review')
          await tx
            .update(s.reviews)
            .set({ status: 'failed', stage: 'failed', completedAt: new Date(), errorCode: code })
            .where(
              and(eq(s.reviews.id, job.targetId), inArray(s.reviews.status, ['queued', 'running'])),
            );
      });
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
  private async processDocument(id: string, owns: (db: Transaction) => Promise<void>) {
    const { db, storage, config } = this.service;
    const [d] = await db.select().from(s.documents).where(eq(s.documents.id, id));
    if (!d || d.deletedAt || d.extractionStatus === 'completed') return;
    await db
      .update(s.documents)
      .set({ extractionStatus: 'processing' })
      .where(eq(s.documents.id, id));
    const allPages = await extract(await storage.get(d.storageKey), d.mimeType, d.id, config);
    const classification = classify(allPages);
    const facts = extractFacts(allPages);
    await db.transaction(async (tx) => {
      await owns(tx);
      const [current] = await tx
        .select()
        .from(s.documents)
        .where(eq(s.documents.id, id))
        .for('update');
      if (!current || current.deletedAt) return;
      await tx.delete(s.pages).where(eq(s.pages.documentId, id));
      for (const p of allPages)
        await tx.insert(s.pages).values({
          documentId: id,
          pageIndex: p.pageNumber - 1,
          text: p.text,
          method: p.method,
          status: p.status,
        });
      await tx
        .update(s.documents)
        .set({ extractionStatus: 'completed', classification, facts, errorCode: null })
        .where(eq(s.documents.id, id));
    });
  }
  private async processReview(
    id: string,
    organizationId: string,
    owns: (db: Transaction) => Promise<void>,
  ) {
    const { db, config } = this.service;
    const [run] = await db.select().from(s.reviews).where(eq(s.reviews.id, id));
    if (!run || ['completed', 'redacted'].includes(run.status)) return;
    const input = run.inputSnapshot as {
      project: typeof s.projects.$inferSelect;
      documentIds: string[];
      documents: unknown[];
    };
    const [ruleset] = await db.select().from(s.rulesets).where(eq(s.rulesets.id, run.rulesetId));
    assert(ruleset, 422, 'RULESET_MISSING', 'Ruleset unavailable');
    const rules = z.array(ruleSchema).parse(ruleset.snapshot);
    await db
      .update(s.reviews)
      .set({ status: 'running', stage: 'extracting', startedAt: run.startedAt ?? new Date() })
      .where(eq(s.reviews.id, id));
    const docs = await db
      .select()
      .from(s.documents)
      .where(inArray(s.documents.id, input.documentIds));
    assert(
      docs.length === input.documentIds.length && !docs.some((d) => d.deletedAt),
      422,
      'INPUT_REMOVED',
      'Review input unavailable',
    );
    if (docs.some((d) => ['queued', 'processing'].includes(d.extractionStatus)))
      throw new Deferred();
    await db.update(s.reviews).set({ stage: 'classifying' }).where(eq(s.reviews.id, id));
    const pp = await db
      .select()
      .from(s.pages)
      .where(inArray(s.pages.documentId, input.documentIds))
      .orderBy(s.pages.pageIndex);
    const allPages: Page[] = pp.map((p) => ({
      documentId: p.documentId,
      pageNumber: p.pageIndex + 1,
      text: p.text,
      status: p.status,
      method: p.method,
    }));
    const reviewDocs: ReviewDocument[] = docs.map((d) => ({
      id: d.id,
      filename: d.originalFilename,
      extractionStatus: d.extractionStatus,
      classification: d.classification
        ? classificationSchema.parse(d.classification)
        : { type: 'unknown', method: 'unknown', evidence: [] },
      facts: z.array(factSchema).parse(d.facts ?? []),
      pages: allPages.filter((p) => p.documentId === d.id),
    }));
    const aiWarnings: string[] = [];
    let aiUsed = false;
    const semantic: Awaited<ReturnType<typeof interpret>>[] = [];
    if (config.AI_ENABLED)
      for (const d of reviewDocs) {
        try {
          const result = await interpret(db, config, organizationId, d.pages, rules);
          if (!result) continue;
          aiUsed = true;
          // AI may propose interpretations; deterministic facts and categories retain precedence.
          if (d.classification.type === 'unknown' && result.classification)
            d.classification = result.classification;
          const keys = new Set(d.facts.map((f) => f.field));
          d.facts.push(...result.facts.filter((f) => !keys.has(f.field)));
          semantic.push(result);
        } catch (e) {
          aiWarnings.push(e instanceof AppError ? e.code : 'AI_UNAVAILABLE');
        }
      }
    await db.update(s.reviews).set({ stage: 'checking_requirements' }).where(eq(s.reviews.id, id));
    const result = evaluate(rules, reviewDocs);
    for (const r of semantic)
      for (const m of r?.semanticMatches ?? []) {
        const rule = rules.find((r) => r.id === m.requirementId)!;
        const finding = result.find((f) => f.requirementId === m.requirementId);
        if (
          finding &&
          finding.category === 'Unable to determine' &&
          rule.stage === 'application' &&
          applicability(
            rule,
            reviewDocs.flatMap((d) => d.facts),
          ) === 'yes'
        )
          Object.assign(finding, {
            category: 'Needs human review',
            interpretation: 'ai',
            evidence: m.evidence,
            explanation:
              'AI identified potentially relevant text for this verified requirement. A qualified person must confirm the semantic match.',
          });
      }
    assert(
      result.every((f) => f.evidence.every((e) => verifySpan(e, allPages))),
      422,
      'EVIDENCE_INVALID',
      'Finding evidence validation failed',
    );
    await db.update(s.reviews).set({ stage: 'generating_findings' }).where(eq(s.reviews.id, id));
    const [jurisdiction] = await db
      .select()
      .from(s.jurisdictions)
      .where(eq(s.jurisdictions.id, input.project.jurisdictionId));
    const [profile] = await db
      .select()
      .from(s.profiles)
      .where(eq(s.profiles.id, input.project.permitProfileId));
    const report = {
      schemaVersion: '1',
      reviewId: id,
      project: input.project,
      jurisdiction: jurisdiction.name,
      permitCategory: profile.displayName,
      reviewDate: new Date().toISOString(),
      rulesetVersion: run.rulesetVersion,
      synthetic: ruleset.synthetic,
      requirements: rules,
      findings: result,
      summary: Object.fromEntries(
        [...new Set(result.map((f) => f.category))].map((category) => [
          category,
          result.filter((f) => f.category === category).length,
        ]),
      ),
      documents: reviewDocs.map((d) => ({
        id: d.id,
        filename: d.filename,
        extractionStatus: d.extractionStatus,
        classification: d.classification,
        pages: d.pages.map((p) => ({
          pageNumber: p.pageNumber,
          status: p.status,
          method: p.method,
        })),
      })),
      ai: {
        configured: config.AI_ENABLED,
        used: aiUsed,
        model: aiUsed ? config.AI_MODEL : null,
        warnings: [...new Set(aiWarnings)],
      },
      limitations: LIMITATION,
    };
    reportSchema.parse(report);
    await db.transaction(async (tx) => {
      await owns(tx);
      const [current] = await tx.select().from(s.reviews).where(eq(s.reviews.id, id)).for('update');
      if (current.status === 'completed') return;
      await tx.delete(s.findings).where(eq(s.findings.reviewId, id));
      for (const f of result) {
        const [saved] = await tx
          .insert(s.findings)
          .values({
            reviewId: id,
            requirementId: f.requirementId,
            category: f.category,
            severity: f.severity,
            status: 'open',
            explanation: f.explanation,
            suggestedAction: f.suggestedAction,
            interpretation: f.interpretation,
          })
          .returning();
        if (f.sourceId)
          await tx.insert(s.evidence).values({
            findingId: saved.id,
            officialSourceId: f.sourceId,
            requirementId: f.requirementId,
          });
        for (const e of f.evidence)
          await tx.insert(s.evidence).values({
            findingId: saved.id,
            documentId: e.documentId,
            pageNumber: e.pageNumber,
            textSpan: e.text,
            start: e.start,
            end: e.end,
            officialSourceId: f.sourceId,
            requirementId: f.requirementId,
          });
      }
      await tx
        .update(s.reviews)
        .set({
          status: 'completed',
          stage: 'completed',
          completedAt: new Date(),
          resultSnapshot: report,
          errorCode: null,
        })
        .where(eq(s.reviews.id, id));
      await tx
        .update(s.projects)
        .set({ status: 'reviewed', updatedAt: new Date() })
        .where(eq(s.projects.id, run.projectId));
      await tx.insert(s.audits).values({
        organizationId,
        action: 'review.completed',
        targetId: id,
        metadata: { findingCount: result.length, synthetic: ruleset.synthetic },
      });
    });
  }
}
