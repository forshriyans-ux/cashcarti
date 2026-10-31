import Fastify, { LogController } from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID, createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import type { DB } from './db.js';
import type { Storage } from './storage.js';
import { authenticate, requireAdmin, requireRuleAdmin } from './auth.js';
import { Service } from './service.js';
import { Worker } from './worker.js';
import { projectInput, projectPatch, pagination, reportSchema } from './contracts.js';
import { AppError, assert } from './errors.js';
import {
  publishRuleset,
  requirementInput,
  retrieveSource,
  sourceImport,
  sourceUrl,
} from './registry.js';
import { reportPDF } from './report.js';
import * as s from './schema.js';
const params = z.object({ id: z.string().uuid() }).strict();
const onlyId = (request: { params: unknown }) => params.parse(request.params).id;
const expensive = { rateLimit: { max: 10, timeWindow: '1 minute' } };
function publicDocument(d: typeof s.documents.$inferSelect) {
  const { storageKey, ...safe } = d;
  return safe;
}
function publicReview(r: typeof s.reviews.$inferSelect) {
  const { inputSnapshot, resultSnapshot, ...safe } = r;
  return safe;
}
export async function buildApp(c: Config, db: DB, store: Storage) {
  const app = Fastify({
    bodyLimit: 1_000_000,
    logController: new LogController({ disableRequestLogging: true }),
    logger: c.NODE_ENV === 'test' ? false : { level: 'info' },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    requestTimeout: 120000,
  });
  const service = new Service(db, c, store);
  const worker = new Worker(service, (code, jobId) =>
    app.log.error({ code, jobId }, 'Worker operation failed'),
  );
  await app.register(helmet);
  if (c.CORS_ORIGIN)
    await app.register(cors, {
      origin: c.CORS_ORIGIN,
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Organization-Id'],
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    });
  await app.register(multipart, {
    limits: { fileSize: c.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      error: { code: 'RATE_LIMIT', message: 'Request limit exceeded' },
    }),
  });
  app.setErrorHandler((e, req, reply) => {
    const databaseCode = (e as { cause?: { code?: string } }).cause?.code;
    if (['23505', '23503', '23514'].includes(databaseCode ?? ''))
      return reply.code(databaseCode === '23505' ? 409 : 400).send({
        error: {
          code: databaseCode === '23505' ? 'CONFLICT' : 'INVALID_REFERENCE',
          message:
            databaseCode === '23505'
              ? 'Resource already exists'
              : 'Invalid resource reference or constraint',
          requestId: req.id,
        },
      });
    if (e instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: 'VALIDATION',
          message: 'Invalid request',
          fields: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          requestId: req.id,
        },
      });
    const status = e instanceof AppError ? e.status : (e as { statusCode?: number }).statusCode;
    const safeStatus = typeof status === 'number' && status >= 400 && status < 500 ? status : 500;
    const code =
      e instanceof AppError
        ? e.code
        : safeStatus === 500
          ? 'INTERNAL_ERROR'
          : safeStatus === 413
            ? 'FILE_SIZE'
            : 'REQUEST_REJECTED';
    if (safeStatus === 500) req.log.error({ code, requestId: req.id }, 'Backend operation failed');
    reply.code(safeStatus).send({
      error: {
        code,
        message:
          e instanceof AppError
            ? e.message
            : safeStatus === 500
              ? 'Backend operation failed'
              : 'Request rejected',
        requestId: req.id,
      },
    });
  });
  app.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } }),
  );
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
    if (c.DEMO_MODE) reply.header('x-permitproof-mode', 'synthetic-demo');
  });
  app.get('/api/health', async () => {
    await db.execute(sql`select 1`);
    return {
      status: 'ok',
      mode: c.DEMO_MODE ? 'synthetic-demo' : 'production',
      aiEnabled: c.AI_ENABLED,
      malwareScanning: c.CLAMAV_ENABLED,
      workerEnabled: c.WORKER_ENABLED,
    };
  });
  await app.register(async (api) => {
    api.addHook('preHandler', authenticate(db, c));
    api.addHook('preHandler', async (req) => {
      if (['POST', 'PATCH', 'DELETE'].includes(req.method))
        assert(
          ['owner', 'admin', 'editor'].includes(req.actor.role),
          403,
          'FORBIDDEN',
          'Write access required',
        );
    });
    api.get('/api/me', async (req) => ({
      actor: req.actor,
      mode: c.DEMO_MODE ? 'synthetic-demo' : 'production',
    }));
    api.get('/api/jurisdictions', async (req) => {
      const q = pagination.parse(req.query);
      return {
        data: await db.select().from(s.jurisdictions).limit(q.limit).offset(q.offset),
        ...q,
      };
    });
    api.get('/api/permit-types', async (req) => {
      const q = pagination.parse(req.query);
      return { data: await db.select().from(s.profiles).limit(q.limit).offset(q.offset), ...q };
    });
    api.get('/api/permit-requirements', async (req) => {
      const q = pagination.extend({ profileId: z.string().uuid() }).parse(req.query);
      const sets = await db
        .select()
        .from(s.rulesets)
        .where(eq(s.rulesets.profileId, q.profileId))
        .orderBy(desc(s.rulesets.createdAt))
        .limit(q.limit)
        .offset(q.offset);
      return { data: sets.filter((r) => !r.synthetic || c.DEMO_MODE), ...q };
    });
    api.post('/api/projects', async (req, reply) =>
      reply.code(201).send(await service.createProject(req.actor, projectInput.parse(req.body))),
    );
    api.get('/api/projects', async (req) => {
      const q = pagination.parse(req.query);
      return {
        data: await db
          .select()
          .from(s.projects)
          .where(eq(s.projects.organizationId, req.actor.organizationId))
          .orderBy(desc(s.projects.createdAt))
          .limit(q.limit)
          .offset(q.offset),
        ...q,
      };
    });
    api.get('/api/projects/:id', async (req) => service.project(req.actor, onlyId(req)));
    api.patch('/api/projects/:id', async (req) => {
      const id = onlyId(req);
      await service.project(req.actor, id);
      const input = projectPatch.parse(req.body);
      const [p] = await db
        .update(s.projects)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(s.projects.id, id), eq(s.projects.organizationId, req.actor.organizationId)))
        .returning();
      await service.audit(req.actor, 'project.updated', id);
      return p;
    });
    api.delete('/api/projects/:id', async (req, reply) => {
      requireAdmin(req.actor);
      await service.deleteProject(req.actor, onlyId(req));
      return reply.code(202).send({ status: 'deletion_queued' });
    });
    api.post('/api/projects/:id/documents', { config: expensive }, async (req, reply) => {
      const projectId = onlyId(req);
      await service.project(req.actor, projectId);
      const file = await req.file();
      assert(file, 400, 'FILE_REQUIRED', 'Send one multipart file with each request');
      const data = await file.toBuffer();
      assert(!file.file.truncated, 413, 'FILE_SIZE', 'File size limit exceeded');
      const result = await service.upload(req.actor, projectId, file.filename, file.mimetype, data);
      return reply
        .code(result.duplicate ? 200 : 202)
        .send({ document: publicDocument(result.document), duplicate: result.duplicate });
    });
    api.get('/api/projects/:id/documents', async (req) => {
      const id = onlyId(req);
      await service.project(req.actor, id);
      const q = pagination.parse(req.query);
      return {
        data: (
          await db
            .select()
            .from(s.documents)
            .where(and(eq(s.documents.projectId, id), isNull(s.documents.deletedAt)))
            .orderBy(s.documents.createdAt)
            .limit(q.limit)
            .offset(q.offset)
        ).map(publicDocument),
        ...q,
      };
    });
    api.get('/api/documents/:id', async (req) => {
      const d = await service.document(req.actor, onlyId(req));
      const q = pagination.parse(req.query);
      const pages = await db
        .select({ pageIndex: s.pages.pageIndex, method: s.pages.method, status: s.pages.status })
        .from(s.pages)
        .where(eq(s.pages.documentId, d.id))
        .orderBy(s.pages.pageIndex)
        .limit(q.limit)
        .offset(q.offset);
      return { ...publicDocument(d), pages, ...q };
    });
    api.get('/api/documents/:id/download', async (req, reply) => {
      const d = await service.document(req.actor, onlyId(req));
      await service.audit(req.actor, 'document.downloaded', d.id);
      return reply
        .type(d.mimeType)
        .header(
          'content-disposition',
          `attachment; filename="document-${d.id}.${d.mimeType === 'application/pdf' ? 'pdf' : d.mimeType === 'image/png' ? 'png' : 'jpg'}"`,
        )
        .send(await store.get(d.storageKey));
    });
    api.delete('/api/documents/:id', async (req, reply) => {
      await service.removeDocument(req.actor, onlyId(req));
      return reply.code(202).send({ status: 'deletion_queued' });
    });
    api.post('/api/documents/:id/reprocess', { config: expensive }, async (req, reply) => {
      const d = await service.document(req.actor, onlyId(req));
      assert(
        d.extractionStatus === 'failed',
        409,
        'NOT_FAILED',
        'Only failed extractions can be retried',
      );
      await db.transaction(async (tx) => {
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
        assert(
          !active.length,
          409,
          'PROCESSING_ACTIVE',
          'Wait for the active review before retrying extraction',
        );
        await tx
          .update(s.documents)
          .set({ extractionStatus: 'queued', errorCode: null })
          .where(eq(s.documents.id, d.id));
        await tx
          .update(s.jobs)
          .set({ status: 'queued', attempts: 0, availableAt: new Date(), errorCode: null })
          .where(eq(s.jobs.dedupKey, `extract:${d.id}:v1`));
      });
      await service.audit(req.actor, 'document.reprocess_requested', d.id);
      return reply.code(202).send({ status: 'queued' });
    });
    api.post('/api/projects/:id/reviews', { config: expensive }, async (req, reply) => {
      assert(
        req.body === undefined || req.body === null,
        400,
        'BODY_NOT_ALLOWED',
        'Review requests use the saved project and uploaded documents',
      );
      const result = await service.startReview(req.actor, onlyId(req));
      return reply
        .code(result.duplicate ? 200 : 202)
        .send({ review: publicReview(result.review), duplicate: result.duplicate });
    });
    api.get('/api/projects/:id/reviews', async (req) => {
      const id = onlyId(req);
      await service.project(req.actor, id);
      const q = pagination.parse(req.query);
      return {
        data: (
          await db
            .select()
            .from(s.reviews)
            .where(eq(s.reviews.projectId, id))
            .orderBy(desc(s.reviews.createdAt))
            .limit(q.limit)
            .offset(q.offset)
        ).map(publicReview),
        ...q,
      };
    });
    api.get('/api/reviews/:id', async (req) =>
      publicReview(await service.review(req.actor, onlyId(req))),
    );
    api.get('/api/reviews/:id/findings', async (req) => {
      const r = await service.review(req.actor, onlyId(req));
      assert(
        r.status === 'completed',
        409,
        'REVIEW_NOT_READY',
        'Review is not completed or has been redacted',
      );
      const q = pagination.parse(req.query);
      const findings = await db
        .select()
        .from(s.findings)
        .where(eq(s.findings.reviewId, r.id))
        .orderBy(s.findings.id)
        .limit(q.limit)
        .offset(q.offset);
      const ee = findings.length
        ? await db
            .select()
            .from(s.evidence)
            .where(
              inArray(
                s.evidence.findingId,
                findings.map((f) => f.id),
              ),
            )
        : [];
      return {
        data: findings.map((f) => ({ ...f, evidence: ee.filter((e) => e.findingId === f.id) })),
        ...q,
      };
    });
    const report = async (
      req: Parameters<typeof onlyId>[0] & { actor: import('./auth.js').Actor },
    ) => {
      const r = await service.review(req.actor, onlyId(req));
      assert(
        r.status === 'completed' && r.resultSnapshot,
        409,
        'REPORT_NOT_READY',
        'Report is unavailable until completion, or has been redacted following deletion',
      );
      await service.audit(req.actor, 'report.downloaded', r.id);
      return reportSchema.parse(r.resultSnapshot);
    };
    api.get('/api/reviews/:id/report', async (req) => report(req));
    api.get('/api/reviews/:id/report.pdf', { config: expensive }, async (req, reply) =>
      reply
        .type('application/pdf')
        .header('content-disposition', 'attachment; filename="permitproof-report.pdf"')
        .send(await reportPDF(await report(req))),
    );
    api.get('/api/audit-events', async (req) => {
      requireAdmin(req.actor);
      const q = pagination.parse(req.query);
      return {
        data: await db
          .select()
          .from(s.audits)
          .where(eq(s.audits.organizationId, req.actor.organizationId))
          .orderBy(desc(s.audits.createdAt))
          .limit(q.limit)
          .offset(q.offset),
        ...q,
      };
    });
    await api.register(async (admin) => {
      admin.addHook('preHandler', async (req) => requireRuleAdmin(req.actor));
      admin.get('/api/admin/sources', async (req) => {
        const q = pagination.parse(req.query);
        return {
          data: await db
            .select()
            .from(s.sources)
            .orderBy(s.sources.title)
            .limit(q.limit)
            .offset(q.offset),
          ...q,
        };
      });
      admin.post('/api/admin/sources/retrieve', { config: expensive }, async (req, reply) => {
        const v = z
          .object({
            url: z.string().url(),
            jurisdictionId: z.string().uuid(),
            agency: z.string().min(1).max(200),
          })
          .strict()
          .parse(req.body);
        const officialUrl = sourceUrl(v.url);
        const value = await retrieveSource(officialUrl);
        const [row] = await db
          .insert(s.sources)
          .values({
            agency: v.agency,
            jurisdictionId: v.jurisdictionId,
            officialUrl,
            title: value.title,
            checksum: value.checksum,
            snapshot: value.text,
            retrievedAt: new Date(),
            documentType: 'html',
          })
          .onConflictDoNothing()
          .returning();
        await service.audit(req.actor, 'source.retrieved', row?.id ?? officialUrl);
        return reply.code(row ? 201 : 200).send(row ?? { status: 'unchanged' });
      });
      admin.post('/api/admin/sources/import', async (req, reply) => {
        const v = sourceImport.parse(req.body);
        sourceUrl(v.officialUrl);
        const { attestation, ...rest } = v;
        const checksum = createHash('sha256').update(v.snapshot).digest('hex');
        const [row] = await db
          .insert(s.sources)
          .values({ ...rest, checksum, retrievedAt: new Date() })
          .onConflictDoNothing()
          .returning();
        await service.audit(req.actor, 'source.imported', row?.id ?? v.officialUrl, {
          manualAttestation: true,
        });
        return reply.code(row ? 201 : 200).send(row ?? { status: 'unchanged' });
      });
      admin.post('/api/admin/sources/:id/verify', async (req) => {
        const v = z
          .object({
            attestation: z.literal(
              'I checked the official URL, exact text, currency, jurisdiction, and effective date.',
            ),
          })
          .strict()
          .parse(req.body);
        const id = onlyId(req);
        const [source] = await db.select().from(s.sources).where(eq(s.sources.id, id));
        assert(source, 404, 'NOT_FOUND', 'Source not found');
        assert(
          source.retrievedAt && !source.snapshot.startsWith('CANDIDATE URL ONLY'),
          409,
          'SOURCE_NOT_RETRIEVED',
          'Retrieve or manually import the actual official text before verification',
        );
        assert(
          !source.synthetic || c.DEMO_MODE,
          409,
          'SYNTHETIC',
          'Demo source cannot be verified in production',
        );
        const [row] = await db
          .update(s.sources)
          .set({
            verificationStatus: 'verified',
            lastVerifiedAt: new Date(),
            verifiedBy: req.actor.userId,
          })
          .where(eq(s.sources.id, id))
          .returning();
        await service.audit(req.actor, 'source.verified', id);
        return row;
      });
      admin.post('/api/admin/requirements', async (req, reply) => {
        const v = requirementInput.parse(req.body);
        const [source] = await db.select().from(s.sources).where(eq(s.sources.id, v.sourceId));
        const [profile] = await db.select().from(s.profiles).where(eq(s.profiles.id, v.profileId));
        assert(source && profile, 404, 'NOT_FOUND', 'Source or profile not found');
        assert(
          source.snapshot.includes(v.excerpt),
          400,
          'EXCERPT',
          'Requirement excerpt must be an exact substring of the saved official source',
        );
        assert(
          source.jurisdictionId === profile.jurisdictionId,
          400,
          'JURISDICTION',
          'Source jurisdiction does not match profile',
        );
        const [row] = await db
          .insert(s.requirements)
          .values({ ...v, sourceVersion: source.checksum })
          .returning();
        await service.audit(req.actor, 'requirement.drafted', row.id);
        return reply.code(201).send(row);
      });
      admin.get('/api/admin/requirements', async (req) => {
        const q = pagination.parse(req.query);
        return {
          data: await db.select().from(s.requirements).limit(q.limit).offset(q.offset),
          ...q,
        };
      });
      admin.post('/api/admin/requirements/:id/verify', async (req) => {
        z.object({
          attestation: z.literal(
            'I verified the exact excerpt, stage, applicability, matching logic, and filing-date interval.',
          ),
        })
          .strict()
          .parse(req.body);
        const id = onlyId(req);
        const [r] = await db.select().from(s.requirements).where(eq(s.requirements.id, id));
        assert(r, 404, 'NOT_FOUND', 'Requirement not found');
        const [source] = await db.select().from(s.sources).where(eq(s.sources.id, r.sourceId));
        assert(
          source.verificationStatus === 'verified' && source.snapshot.includes(r.excerpt),
          409,
          'UNVERIFIED_SOURCE',
          'Source must be verified first',
        );
        const [row] = await db
          .update(s.requirements)
          .set({
            verificationStatus: 'verified',
            verifiedAt: new Date(),
            verifiedBy: req.actor.userId,
          })
          .where(eq(s.requirements.id, id))
          .returning();
        await service.audit(req.actor, 'requirement.verified', id);
        return row;
      });
      admin.post('/api/admin/rulesets', async (req, reply) => {
        const v = z
          .object({
            profileId: z.string().uuid(),
            version: z.string().min(1).max(100),
            requirementIds: z
              .array(z.string().uuid())
              .min(1)
              .max(100)
              .refine((v) => new Set(v).size === v.length),
            effectiveFrom: z.string().date(),
            effectiveTo: z.string().date().optional(),
          })
          .strict()
          .parse(req.body);
        return reply.code(201).send(await publishRuleset(db, c, req.actor, v));
      });
    });
  });
  app.addHook('onClose', async () => worker.stop());
  if (c.WORKER_ENABLED) worker.start();
  return { app, service, worker };
}
