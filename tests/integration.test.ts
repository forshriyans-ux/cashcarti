import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { storage } from '../src/storage.js';
import { provision, seedDemo } from '../src/seed.js';
import { SYNTHETIC_PACKET, syntheticPDF } from '../src/fixtures.js';
import * as s from '../src/schema.js';
import { interpret } from '../src/ai.js';
let directory: string;
let database: Awaited<ReturnType<typeof connectDatabase>>;
let env: Awaited<ReturnType<typeof buildApp>>;
let seed: Awaited<ReturnType<typeof seedDemo>>;
let headers: Record<string, string>;
let projectId: string;
let reviewId: string;
let documentId: string;
let pdf: Buffer;
const token = 'synthetic-test-token-'.padEnd(40, 'x');
function multipartBody(data: Buffer, filename = 'packet.pdf', mime = 'application/pdf') {
  const boundary = 'permitproof-' + randomUUID();
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'permitproof-test-'));
  const c = loadConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    DEMO_TOKEN: token,
    WORKER_ENABLED: 'false',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    PGLITE_PATH: ':memory:',
    STORAGE_PATH: join(directory, 'private'),
  });
  database = await connectDatabase(c);
  await database.migrate();
  seed = await seedDemo(database.db, c);
  env = await buildApp(c, database.db, storage(c));
  headers = { authorization: `Bearer ${token}`, 'x-organization-id': seed.actor.organizationId };
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await env?.app.close();
  await database?.close();
  await rm(directory, { recursive: true, force: true });
});
describe('real upload → extraction → review → report → private deletion', () => {
  it('requires authentication, validates inputs, creates and persists a project', async () => {
    expect((await env.app.inject({ url: '/api/projects' })).statusCode).toBe(401);
    expect(
      (
        await env.app.inject({
          url: '/api/projects',
          method: 'POST',
          headers,
          payload: { name: 'invalid' },
        })
      ).statusCode,
    ).toBe(400);
    const response = await env.app.inject({
      url: '/api/projects',
      method: 'POST',
      headers,
      payload: {
        name: 'SYNTHETIC integration ADU',
        jurisdictionId: seed.jurisdiction.id,
        permitProfileId: seed.profile.id,
        filingDate: '2026-10-01',
      },
    });
    expect(response.statusCode).toBe(201);
    projectId = response.json().id;
    expect(
      (await env.app.inject({ url: `/api/projects/${projectId}`, headers })).json().name,
    ).toContain('SYNTHETIC');
    expect(
      (await database.db.select().from(s.projects).where(eq(s.projects.id, projectId)))[0]
        .organizationId,
    ).toBe(seed.actor.organizationId);
  });
  it('accepts real PDFs, privately stores them, and deduplicates repeated uploads', async () => {
    pdf = await syntheticPDF(SYNTHETIC_PACKET[0].lines);
    for (const file of SYNTHETIC_PACKET) {
      const data = await syntheticPDF(file.lines);
      const response = await env.app.inject({
        url: `/api/projects/${projectId}/documents`,
        method: 'POST',
        ...multipartBody(file === SYNTHETIC_PACKET[0] ? pdf : data, file.filename),
      });
      expect(response.statusCode, response.body).toBe(202);
      if (file === SYNTHETIC_PACKET[0]) documentId = response.json().document.id;
      expect(response.json().document.storageKey).toBeUndefined();
    }
    const duplicate = await env.app.inject({
      url: `/api/projects/${projectId}/documents`,
      method: 'POST',
      ...multipartBody(pdf),
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
    const download = await env.app.inject({
      url: `/api/documents/${documentId}/download`,
      headers,
    });
    expect(download.rawPayload.equals(pdf)).toBe(true);
  });
  it('rejects mismatched MIME and corrupted PDF files', async () => {
    const mismatch = await env.app.inject({
      url: `/api/projects/${projectId}/documents`,
      method: 'POST',
      ...multipartBody(Buffer.from('<script>attack</script>')),
    });
    expect(mismatch.statusCode).toBe(415);
    const corrupt = await env.app.inject({
      url: `/api/projects/${projectId}/documents`,
      method: 'POST',
      ...multipartBody(Buffer.from('%PDF-1.7\ncorrupt')),
    });
    expect(corrupt.statusCode).toBe(422);
  });
  it('creates a durable review and prevents duplicate execution', async () => {
    const r = await env.app.inject({
      url: `/api/projects/${projectId}/reviews`,
      method: 'POST',
      headers,
    });
    expect(r.statusCode, r.body).toBe(202);
    reviewId = r.json().review.id;
    expect(
      (
        await env.app.inject({ url: `/api/projects/${projectId}/reviews`, method: 'POST', headers })
      ).json().review.id,
    ).toBe(reviewId);
    expect(
      (await env.app.inject({ url: `/api/reviews/${reviewId}/report`, headers })).statusCode,
    ).toBe(409);
    expect(
      (await env.app.inject({ url: `/api/documents/${documentId}`, method: 'DELETE', headers }))
        .statusCode,
    ).toBe(409);
    for (let i = 0; i < 5; i++) await env.worker.runOne();
    const status = await env.app.inject({ url: `/api/reviews/${reviewId}`, headers });
    expect(status.json().status, status.body).toBe('completed');
  });
  it('extracts exact per-page evidence and returns the labeled deterministic findings', async () => {
    const pages = await database.db
      .select()
      .from(s.pages)
      .where(eq(s.pages.documentId, documentId));
    expect(pages.length).toBe(1);
    expect(pages[0].method).toBe('embedded');
    const r = await env.app.inject({ url: `/api/reviews/${reviewId}/report`, headers });
    expect(r.statusCode).toBe(200);
    const report = r.json();
    expect(report.synthetic).toBe(true);
    expect(report.findings.length).toBe(8);
    expect(report.summary).toEqual({
      'Verified present': 3,
      'Potentially missing': 1,
      'Needs human review': 2,
      'Not applicable': 1,
      'Inconsistent information': 1,
    });
    for (const f of report.findings)
      for (const e of f.evidence) {
        const [p] = await database.db
          .select()
          .from(s.pages)
          .where(
            and(eq(s.pages.documentId, e.documentId), eq(s.pages.pageIndex, e.pageNumber - 1)),
          );
        expect(p.text.slice(e.start, e.end)).toBe(e.text);
      }
    const findings = (
      await env.app.inject({ url: `/api/reviews/${reviewId}/findings?limit=3`, headers })
    ).json();
    expect(findings.data.length).toBe(3);
    expect(findings.data.some((f: any) => f.evidence.length)).toBe(true);
  });
  it('downloads a real PDF and keeps completed reports stable', async () => {
    const r = await env.app.inject({ url: `/api/reviews/${reviewId}/report.pdf`, headers });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const before = (await env.app.inject({ url: `/api/reviews/${reviewId}/report`, headers })).body;
    await env.app.inject({
      url: `/api/projects/${projectId}`,
      method: 'PATCH',
      headers,
      payload: { name: 'Changed project name' },
    });
    expect((await env.app.inject({ url: `/api/reviews/${reviewId}/report`, headers })).body).toBe(
      before,
    );
  });
  it('isolates another organization across reads, writes, downloads and reports', async () => {
    const other = await provision(
      database.db,
      'synthetic:other',
      'other@example.invalid',
      'SYNTHETIC other',
    );
    const [project] = await database.db
      .insert(s.projects)
      .values({
        organizationId: other.organizationId,
        name: 'Private other',
        projectType: 'new_adu',
        jurisdictionId: seed.jurisdiction.id,
        permitProfileId: seed.profile.id,
        filingDate: '2026-10-01',
      })
      .returning();
    expect((await env.app.inject({ url: `/api/projects/${project.id}`, headers })).statusCode).toBe(
      404,
    );
    expect(
      (
        await env.app.inject({
          url: `/api/projects/${project.id}`,
          method: 'PATCH',
          headers,
          payload: { name: 'attack' },
        })
      ).statusCode,
    ).toBe(404);
    const changed = { ...headers, 'x-organization-id': other.organizationId };
    for (const url of [
      `/api/projects/${projectId}`,
      `/api/documents/${documentId}/download`,
      `/api/reviews/${reviewId}/report`,
      `/api/reviews/${reviewId}/findings`,
    ])
      expect((await env.app.inject({ url, headers: changed })).statusCode).toBe(404);
  });
  it('fails closed without a verified filing-date ruleset and rejects unsupported profile pairs', async () => {
    const p = await env.service.createProject(seed.actor, {
      name: 'SYNTHETIC no rules',
      jurisdictionId: seed.jurisdiction.id,
      permitProfileId: seed.profile.id,
      filingDate: '2025-01-01',
    });
    expect(
      (
        await env.app.inject({ url: `/api/projects/${p.id}/reviews`, method: 'POST', headers })
      ).json().error.code,
    ).toBe('NO_VERIFIED_RULESET');
    expect(
      (
        await env.app.inject({
          url: '/api/projects',
          method: 'POST',
          headers,
          payload: {
            name: 'invalid',
            jurisdictionId: randomUUID(),
            permitProfileId: seed.profile.id,
            filingDate: '2026-01-01',
          },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('enforces exact official excerpts, source verification, domain restrictions and global admin rights', async () => {
    const candidate = (
      await database.db
        .select()
        .from(s.sources)
        .where(eq(s.sources.verificationStatus, 'candidate'))
    )[0];
    expect(
      (
        await env.app.inject({
          url: `/api/admin/sources/${candidate.id}/verify`,
          method: 'POST',
          headers,
          payload: {
            attestation:
              'I checked the official URL, exact text, currency, jurisdiction, and effective date.',
          },
        })
      ).json().error.code,
    ).toBe('SOURCE_NOT_RETRIEVED');
    const input = {
      sourceId: candidate.id,
      profileId: seed.profile.id,
      description: 'SYNTHETIC test',
      applicability: {},
      stage: 'application',
      severity: 'warning',
      matching: { kind: 'document_type', documentType: 'site_plan' },
      excerpt: 'invented text',
      location: 'test',
      effectiveFrom: '2026-01-01',
    };
    expect(
      (
        await env.app.inject({
          url: '/api/admin/requirements',
          method: 'POST',
          headers,
          payload: input,
        })
      ).json().error.code,
    ).toBe('EXCERPT');
    expect(
      (
        await env.app.inject({
          url: '/api/admin/sources/retrieve',
          method: 'POST',
          headers,
          payload: {
            url: 'https://127.0.0.1/secret',
            jurisdictionId: seed.jurisdiction.id,
            agency: 'test',
          },
        })
      ).statusCode,
    ).toBe(400);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('blocked', { status: 403 })));
    const failed = await env.app.inject({
      url: '/api/admin/sources/retrieve',
      method: 'POST',
      headers,
      payload: { url: candidate.officialUrl, jurisdictionId: seed.jurisdiction.id, agency: 'test' },
    });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().error.code).toBe('SOURCE_FETCH_FAILED');
    vi.unstubAllGlobals();
    await database.db
      .update(s.users)
      .set({ ruleAdmin: false })
      .where(eq(s.users.id, seed.actor.userId));
    expect((await env.app.inject({ url: '/api/admin/sources', headers })).statusCode).toBe(403);
    await database.db
      .update(s.users)
      .set({ ruleAdmin: true })
      .where(eq(s.users.id, seed.actor.userId));
  });
  it('publishes only after human verification and pins exact source metadata', async () => {
    const [source] = await database.db
      .select()
      .from(s.sources)
      .where(eq(s.sources.synthetic, true));
    const excerpt = (seed.ruleset.snapshot as any[])[0].excerpt;
    const draft = await env.app.inject({
      url: '/api/admin/requirements',
      method: 'POST',
      headers,
      payload: {
        sourceId: source.id,
        profileId: seed.profile.id,
        description: 'SYNTHETIC API verification fixture',
        applicability: {},
        stage: 'application',
        severity: 'warning',
        matching: { kind: 'document_type', documentType: 'building_permit_application' },
        excerpt,
        location: 'Synthetic test excerpt',
        effectiveFrom: '2027-01-01',
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const payload = {
      profileId: seed.profile.id,
      version: 'SYNTHETIC-API-WORKFLOW',
      requirementIds: [draft.json().id],
      effectiveFrom: '2027-01-01',
    };
    expect(
      (
        await env.app.inject({ url: '/api/admin/rulesets', method: 'POST', headers, payload })
      ).json().error.code,
    ).toBe('UNVERIFIED_RULE');
    expect(
      (
        await env.app.inject({
          url: `/api/admin/requirements/${draft.json().id}/verify`,
          method: 'POST',
          headers,
          payload: {
            attestation:
              'I verified the exact excerpt, stage, applicability, matching logic, and filing-date interval.',
          },
        })
      ).statusCode,
    ).toBe(200);
    const result = await env.app.inject({
      url: '/api/admin/rulesets',
      method: 'POST',
      headers,
      payload,
    });
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json().synthetic).toBe(true);
    expect(result.json().snapshot[0].sourceVersion).toBe(source.checksum);
    expect(result.json().snapshot[0].sourceVerifiedAt).toBeTruthy();
    expect(
      (await env.app.inject({ url: '/api/admin/rulesets', method: 'POST', headers, payload }))
        .statusCode,
    ).toBe(409);
  });
  it('uses OCR for a scanned synthetic document', async () => {
    const svg = Buffer.from(
      '<svg width="1800" height="400"><rect width="100%" height="100%" fill="white"/><text x="50" y="100" font-size="52" fill="black">Building Permit Application</text><text x="50" y="190" font-size="42" fill="black">SYNTHETIC TEST DOCUMENT</text></svg>',
    );
    const png = await sharp(svg).png().toBuffer();
    const d = await env.service.upload(
      seed.actor,
      projectId,
      'synthetic-scan.png',
      'image/png',
      png,
    );
    await env.worker.runOne();
    const pages = await database.db
      .select()
      .from(s.pages)
      .where(eq(s.pages.documentId, d.document.id));
    expect(pages[0].method).toBe('ocr');
    expect(pages[0].text).toContain('Building Permit Application');
  });
  it('records provider failures, keeps credentials server-side and enforces AI budgets', async () => {
    const c = {
      ...env.service.config,
      AI_ENABLED: true,
      AI_API_KEY: 'synthetic-secret',
      AI_DAILY_CALL_LIMIT: 1,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })));
    await expect(
      interpret(
        database.db,
        c,
        seed.actor.organizationId,
        [
          {
            documentId,
            pageNumber: 1,
            text: 'SYNTHETIC page text',
            method: 'embedded',
            status: 'readable',
          },
        ],
        [],
      ),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    await expect(
      interpret(
        database.db,
        c,
        seed.actor.organizationId,
        [
          {
            documentId,
            pageNumber: 1,
            text: 'different synthetic input',
            method: 'embedded',
            status: 'readable',
          },
        ],
        [],
      ),
    ).rejects.toMatchObject({ code: 'AI_BUDGET' });
    vi.unstubAllGlobals();
  });
  it('retries transient extraction failures, exposes terminal failure and supports recovery', async () => {
    const file = await syntheticPDF([
      'SYNTHETIC FAILURE CASE',
      'Building Permit Application',
      'Project description: Fixture for transient storage failure.',
    ]);
    const { document } = await env.service.upload(
      seed.actor,
      projectId,
      'synthetic-retry.pdf',
      'application/pdf',
      file,
    );
    const get = env.service.storage.get;
    env.service.storage.get = async () => {
      throw new Error('private internal details must never appear in errors');
    };
    try {
      for (let i = 0; i < 3; i++) {
        await env.worker.runOne();
        await database.db
          .update(s.jobs)
          .set({ availableAt: new Date(0) })
          .where(eq(s.jobs.targetId, document.id));
      }
      expect(
        (await env.app.inject({ url: `/api/documents/${document.id}`, headers })).json()
          .extractionStatus,
      ).toBe('failed');
    } finally {
      env.service.storage.get = get;
    }
    expect(
      (
        await env.app.inject({
          url: `/api/documents/${document.id}/reprocess`,
          method: 'POST',
          headers,
        })
      ).statusCode,
    ).toBe(202);
    await env.worker.runOne();
    expect(
      (await env.app.inject({ url: `/api/documents/${document.id}`, headers })).json()
        .extractionStatus,
    ).toBe('completed');
  });
  it('recovers expired leases and redacts derived content on deletion', async () => {
    const [old] = await database.db.select().from(s.jobs).where(eq(s.jobs.targetId, documentId));
    await database.db
      .update(s.jobs)
      .set({ status: 'running', leaseToken: randomUUID(), leaseUntil: new Date(0) })
      .where(eq(s.jobs.id, old.id));
    await env.worker.runOne();
    expect((await database.db.select().from(s.jobs).where(eq(s.jobs.id, old.id)))[0].status).toBe(
      'completed',
    );
    const [d] = await database.db.select().from(s.documents).where(eq(s.documents.id, documentId));
    const deletion = await env.app.inject({
      url: `/api/documents/${documentId}`,
      method: 'DELETE',
      headers,
    });
    expect(deletion.statusCode, deletion.body).toBe(202);
    expect(
      (await env.app.inject({ url: `/api/documents/${documentId}/download`, headers })).statusCode,
    ).toBe(404);
    expect(
      (await env.app.inject({ url: `/api/reviews/${reviewId}/report`, headers })).statusCode,
    ).toBe(409);
    await env.worker.runOne();
    expect(
      await database.db.select().from(s.documents).where(eq(s.documents.id, documentId)),
    ).toHaveLength(0);
    await expect(env.service.storage.get(d.storageKey)).rejects.toThrow();
    const usage = await database.db.select().from(s.aiUsage);
    expect(usage[0].response).toBeNull();
    expect(usage.length).toBe(1);
  });
  it('enforces retention and completes project deletion without orphaned active files', async () => {
    const file = await syntheticPDF([
      'SYNTHETIC RETENTION CASE',
      'Building Permit Application',
      'Project description: Synthetic retention fixture.',
    ]);
    const { document } = await env.service.upload(
      seed.actor,
      projectId,
      'synthetic-retention.pdf',
      'application/pdf',
      file,
    );
    await database.db
      .update(s.documents)
      .set({ createdAt: new Date(0) })
      .where(eq(s.documents.id, document.id));
    expect(await env.service.retention()).toBe(1);
    expect(
      (await env.app.inject({ url: `/api/documents/${document.id}`, headers })).statusCode,
    ).toBe(404);
    for (let i = 0; i < 3; i++) await env.worker.runOne();
    const response = await env.app.inject({
      url: `/api/projects/${projectId}`,
      method: 'DELETE',
      headers,
    });
    expect(response.statusCode, response.body).toBe(202);
    for (let i = 0; i < 10; i++) await env.worker.runOne();
    expect((await env.app.inject({ url: `/api/projects/${projectId}`, headers })).statusCode).toBe(
      404,
    );
  });
});
