import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { DB } from './db.js';
import type { Config } from './config.js';
import type { Actor } from './auth.js';
import type { Storage } from './storage.js';
import * as s from './schema.js';
import { assert, AppError } from './errors.js';
import { validateFile } from './extraction.js';
import type { ProjectInput } from './contracts.js';
export class Service {
  constructor(
    public db: DB,
    public config: Config,
    public storage: Storage,
  ) {}
  async audit(
    actor: Actor,
    action: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ) {
    await this.db.insert(s.audits).values({
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action,
      targetId,
      metadata,
    });
  }
  async project(actor: Actor, id: string) {
    const [p] = await this.db
      .select()
      .from(s.projects)
      .where(and(eq(s.projects.id, id), eq(s.projects.organizationId, actor.organizationId)));
    assert(p, 404, 'NOT_FOUND', 'Project not found');
    return p;
  }
  async document(actor: Actor, id: string) {
    const [d] = await this.db.select().from(s.documents).where(eq(s.documents.id, id));
    assert(d && !d.deletedAt, 404, 'NOT_FOUND', 'Document not found');
    await this.project(actor, d.projectId);
    return d;
  }
  async review(actor: Actor, id: string) {
    const [r] = await this.db.select().from(s.reviews).where(eq(s.reviews.id, id));
    assert(r, 404, 'NOT_FOUND', 'Review not found');
    await this.project(actor, r.projectId);
    return r;
  }
  async createProject(actor: Actor, input: ProjectInput) {
    const [profile] = await this.db
      .select()
      .from(s.profiles)
      .where(
        and(
          eq(s.profiles.id, input.permitProfileId),
          eq(s.profiles.jurisdictionId, input.jurisdictionId),
        ),
      );
    assert(profile, 400, 'PROFILE', 'Jurisdiction and permit profile do not match');
    const [p] = await this.db
      .insert(s.projects)
      .values({ ...input, projectType: 'new_adu', organizationId: actor.organizationId })
      .returning();
    await this.audit(actor, 'project.created', p.id);
    return p;
  }
  async upload(actor: Actor, projectId: string, filename: string, claimed: string, data: Buffer) {
    await this.project(actor, projectId);
    const mime = await validateFile(data, claimed, this.config);
    const checksum = createHash('sha256').update(data).digest('hex');
    const key = `${actor.organizationId}/${randomUUID()}`;
    // Object creation precedes the transaction; every rollback/duplicate removes the unused object.
    await this.storage.put(key, data, mime);
    let retained = false;
    try {
      const result = await this.db.transaction(async (tx) => {
        const [p] = await tx
          .select()
          .from(s.projects)
          .where(
            and(eq(s.projects.id, projectId), eq(s.projects.organizationId, actor.organizationId)),
          )
          .for('update');
        assert(p, 404, 'NOT_FOUND', 'Project not found');
        assert(p.status !== 'deleting', 409, 'PROJECT_DELETING', 'Project deletion is in progress');
        const [duplicate] = await tx
          .select()
          .from(s.documents)
          .where(and(eq(s.documents.projectId, projectId), eq(s.documents.checksum, checksum)));
        if (duplicate && !duplicate.deletedAt) return { document: duplicate, duplicate: true };
        assert(
          !duplicate,
          409,
          'DELETED_DUPLICATE',
          'A prior identical file is awaiting deletion cleanup',
        );
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(s.documents)
          .where(and(eq(s.documents.projectId, projectId), isNull(s.documents.deletedAt)));
        assert(
          count < this.config.MAX_PROJECT_DOCUMENTS,
          409,
          'DOCUMENT_LIMIT',
          'Project document limit reached',
        );
        const safeName =
          filename
            .replace(/\\/g, '/')
            .split('/')
            .pop()!
            .replace(/[\x00-\x1f\x7f]/g, '')
            .slice(0, 200) || 'document';
        const [d] = await tx
          .insert(s.documents)
          .values({
            projectId,
            originalFilename: safeName,
            mimeType: mime,
            size: data.length,
            storageKey: key,
            checksum,
          })
          .returning();
        await tx.insert(s.jobs).values({
          organizationId: actor.organizationId,
          kind: 'extract',
          targetId: d.id,
          dedupKey: `extract:${d.id}:v1`,
        });
        await tx.insert(s.audits).values({
          actorId: actor.userId,
          organizationId: actor.organizationId,
          action: 'document.uploaded',
          targetId: d.id,
          metadata: { size: data.length, mime },
        });
        return { document: d, duplicate: false };
      });
      retained = !result.duplicate;
      return result;
    } finally {
      if (!retained) await this.storage.delete(key);
    }
  }
  async startReview(actor: Actor, projectId: string) {
    return this.db.transaction(async (tx) => {
      const [p] = await tx
        .select()
        .from(s.projects)
        .where(
          and(eq(s.projects.id, projectId), eq(s.projects.organizationId, actor.organizationId)),
        )
        .for('update');
      assert(p, 404, 'NOT_FOUND', 'Project not found');
      assert(p.status !== 'deleting', 409, 'PROJECT_DELETING', 'Project deletion is in progress');
      const all = await tx
        .select()
        .from(s.rulesets)
        .where(eq(s.rulesets.profileId, p.permitProfileId))
        .orderBy(desc(s.rulesets.createdAt));
      const ruleset = all.find(
        (r) =>
          r.effectiveFrom <= p.filingDate &&
          (!r.effectiveTo || r.effectiveTo >= p.filingDate) &&
          (!r.synthetic || this.config.DEMO_MODE),
      );
      assert(
        ruleset,
        409,
        'NO_VERIFIED_RULESET',
        'No published verified ruleset covers this filing date. An administrator must verify official sources and publish a ruleset.',
      );
      const docs = await tx
        .select()
        .from(s.documents)
        .where(and(eq(s.documents.projectId, projectId), isNull(s.documents.deletedAt)))
        .orderBy(s.documents.id);
      assert(docs.length, 409, 'NO_DOCUMENTS', 'Upload at least one document');
      const inputSnapshot = {
        project: p,
        documentIds: docs.map((d) => d.id),
        documents: docs.map((d) => ({
          id: d.id,
          filename: d.originalFilename,
          checksum: d.checksum,
        })),
        rulesetId: ruleset.id,
      };
      const inputHash = createHash('sha256')
        .update(
          JSON.stringify({
            project: { name: p.name, address: p.address, filingDate: p.filingDate },
            documents: inputSnapshot.documents,
            ruleset: ruleset.id,
            engine: 'v1',
            ai: this.config.AI_ENABLED ? this.config.AI_MODEL : null,
          }),
        )
        .digest('hex');
      const [old] = await tx
        .select()
        .from(s.reviews)
        .where(and(eq(s.reviews.projectId, projectId), eq(s.reviews.inputHash, inputHash)));
      if (old) {
        if (old.status === 'failed') {
          const [retried] = await tx
            .update(s.reviews)
            .set({ status: 'queued', stage: 'queued', errorCode: null, completedAt: null })
            .where(eq(s.reviews.id, old.id))
            .returning();
          await tx
            .update(s.jobs)
            .set({ status: 'queued', attempts: 0, availableAt: new Date(), errorCode: null })
            .where(eq(s.jobs.dedupKey, `review:${old.id}:v1`));
          return { review: retried, duplicate: true };
        }
        return { review: old, duplicate: true };
      }
      const [r] = await tx
        .insert(s.reviews)
        .values({
          projectId,
          rulesetId: ruleset.id,
          rulesetVersion: ruleset.version,
          inputSnapshot,
          inputHash,
          model: this.config.AI_ENABLED ? this.config.AI_MODEL : null,
        })
        .returning();
      await tx.insert(s.jobs).values({
        organizationId: actor.organizationId,
        kind: 'review',
        targetId: r.id,
        dedupKey: `review:${r.id}:v1`,
      });
      await tx
        .insert(s.projects)
        .values(p)
        .onConflictDoUpdate({
          target: s.projects.id,
          set: { status: 'reviewing', updatedAt: new Date() },
        });
      await tx.insert(s.audits).values({
        actorId: actor.userId,
        organizationId: actor.organizationId,
        action: 'review.requested',
        targetId: r.id,
        metadata: { rulesetVersion: ruleset.version },
      });
      return { review: r, duplicate: false };
    });
  }
  async removeDocument(actor: Actor, id: string) {
    const d = await this.document(actor, id);
    await this.db.transaction(async (tx) => {
      await tx.select().from(s.projects).where(eq(s.projects.id, d.projectId)).for('update');
      const active = await tx
        .select()
        .from(s.reviews)
        .where(
          and(
            eq(s.reviews.projectId, d.projectId),
            inArray(s.reviews.status, ['queued', 'running']),
          ),
        );
      const running = await tx
        .select()
        .from(s.jobs)
        .where(and(eq(s.jobs.targetId, id), eq(s.jobs.status, 'running')));
      assert(
        !active.length && !running.length,
        409,
        'PROCESSING_ACTIVE',
        'Wait for active processing to finish before deletion',
      );
      await tx
        .update(s.jobs)
        .set({ status: 'cancelled' })
        .where(and(eq(s.jobs.targetId, id), eq(s.jobs.status, 'queued')));
      await tx
        .update(s.documents)
        .set({ deletedAt: new Date(), uploadStatus: 'deleting' })
        .where(eq(s.documents.id, id));
      const affected = await tx
        .select({ id: s.reviews.id })
        .from(s.reviews)
        .where(eq(s.reviews.projectId, d.projectId));
      // Privacy deletion removes derived private text, including cached AI responses and report snapshots.
      if (affected.length) {
        await tx.delete(s.findings).where(
          inArray(
            s.findings.reviewId,
            affected.map((r) => r.id),
          ),
        );
        await tx
          .update(s.reviews)
          .set({ status: 'redacted', resultSnapshot: null })
          .where(eq(s.reviews.projectId, d.projectId));
      }
      await tx
        .update(s.aiUsage)
        .set({ response: null, status: 'redacted' })
        .where(eq(s.aiUsage.organizationId, actor.organizationId));
      await tx
        .insert(s.jobs)
        .values({
          organizationId: actor.organizationId,
          kind: 'delete',
          targetId: id,
          dedupKey: `delete:${id}:v1`,
        })
        .onConflictDoNothing();
      await tx.insert(s.audits).values({
        actorId: actor.userId,
        organizationId: actor.organizationId,
        action: 'document.deletion_requested',
        targetId: id,
        metadata: { derivedReportsRedacted: true },
      });
    });
  }
  async deleteProject(actor: Actor, id: string) {
    const p = await this.project(actor, id);
    await this.db.transaction(async (tx) => {
      await tx.select().from(s.projects).where(eq(s.projects.id, id)).for('update');
      const active = await tx
        .select()
        .from(s.reviews)
        .where(and(eq(s.reviews.projectId, id), inArray(s.reviews.status, ['queued', 'running'])));
      const docs = await tx.select().from(s.documents).where(eq(s.documents.projectId, id));
      const running = docs.length
        ? await tx
            .select()
            .from(s.jobs)
            .where(
              and(
                inArray(
                  s.jobs.targetId,
                  docs.map((d) => d.id),
                ),
                eq(s.jobs.status, 'running'),
              ),
            )
        : [];
      assert(
        !active.length && !running.length,
        409,
        'PROCESSING_ACTIVE',
        'Wait for active processing before deleting the project',
      );
      await tx.update(s.projects).set({ status: 'deleting' }).where(eq(s.projects.id, id));
    });
    const docs = await this.db
      .select()
      .from(s.documents)
      .where(and(eq(s.documents.projectId, id), isNull(s.documents.deletedAt)));
    for (const d of docs) await this.removeDocument(actor, d.id);
    // Keep project until durable object deletion has completed; final purge is a job.
    await this.db
      .insert(s.jobs)
      .values({
        organizationId: actor.organizationId,
        kind: 'purge_project',
        targetId: id,
        dedupKey: `purge:${id}`,
      })
      .onConflictDoNothing();
  }
  async retention() {
    const cutoff = new Date(Date.now() - this.config.RETENTION_DAYS * 86400000);
    const expired = await this.db
      .select({ d: s.documents, p: s.projects })
      .from(s.documents)
      .innerJoin(s.projects, eq(s.documents.projectId, s.projects.id))
      .where(and(lte(s.documents.createdAt, cutoff), isNull(s.documents.deletedAt)))
      .limit(100);
    for (const { d, p } of expired) {
      const [org] = await this.db
        .select()
        .from(s.organizations)
        .where(eq(s.organizations.id, p.organizationId));
      try {
        await this.removeDocument(
          { userId: org.ownerId, organizationId: org.id, role: 'owner', ruleAdmin: false },
          d.id,
        );
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== 'PROCESSING_ACTIVE') throw e;
      }
    }
    return expired.length;
  }
}
