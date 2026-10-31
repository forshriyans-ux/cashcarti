# PermitProof backend

Functional TypeScript backend for permit-packet preparation. It checks document evidence and consistency; it does not determine building-code compliance, structural safety, legal compliance, or city approval.

Repository inspection found an empty `cashcarti` repository: no commits, branches, UI files, package manifest, API conventions, authentication, database, or existing environment-variable declarations. No frontend was replaced or restyled. This service and its typed client are ready to connect when the actual PermitProof interface is added. **The requested existing-interface integration is not complete because that interface is absent.**

## Launch the deterministic demo

Requires Node.js 24+, npm, Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`), and Tesseract with English language data. Debian/Ubuntu system dependencies:

```sh
sudo apt-get update
sudo apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-eng
```

From this repository:

```sh
npm ci
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Put the generated value in .env as DEMO_TOKEN. Keep .env private.
npm run db:migrate
npm run demo:seed
npm run dev
```

In a second terminal in the same directory:

```sh
npm run demo:run
```

The HTTP script creates a persisted project, uploads two real fictional PDFs, waits for actual processing, and downloads JSON and PDF reports to `data/generated/`. The fixture PDFs are in `data/synthetic-packet/`. The service is at `http://127.0.0.1:3001`; `GET /api/health` checks database readiness. There is no frontend route at `/`.

Without `DATABASE_URL`, development uses persistent PGlite, an embedded PostgreSQL engine. This is not browser local storage or an in-memory mock. Run only one service process and stop it before running maintenance CLIs that open the same PGlite directory. Production requires ordinary PostgreSQL. To use it locally, run `docker compose up -d db`, set the commented `DATABASE_URL` in `.env`, and apply migrations and seeds again.

The seeded rules are fictional. Every report and API response identifies synthetic demo mode. No government requirements are implied by those fixture rules. The two conflicting fictional addresses, missing certification, blank owner name, unspecified ADU type, issuance-stage rule, and clean document-presence checks have reproducible expected results.

## Validation

```sh
npm run typecheck
npm test
npm run evaluate
npm run build
npm audit --omit=dev
```

Unit and integration tests run without paid credentials. Integration tests use a fresh in-memory PostgreSQL engine, real Poppler and Tesseract processes, real files, and real PDF reports. Signed-token tests use generated RSA keys and a local JWKS fixture; they do not call an identity provider. For the production driver, point `TEST_DATABASE_URL` at a dedicated, fresh PostgreSQL test database:

```sh
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/permitproof_test npm test
```

Do not point tests at customer data. The integration suite writes synthetic rows. Use a fresh test database for each run.

`npm run evaluate` compares labeled synthetic cases with computed results. It reports omission counts, false positives and false negatives, exact evidence-reference counts, and expected abstentions. It is a small deterministic regression evaluation, not an estimate of real-world or model accuracy.

## Architecture and models

One Fastify server contains validated REST routes, an authorization boundary, a typed service layer, private storage adapters, and a durable PostgreSQL job worker. Drizzle describes the database; checked-in SQL migrations are applied explicitly, never automatically on server startup. `src/client.ts` and `src/api-types.ts` are browser-compatible typed integration interfaces. JSON schemas are in `docs/openapi.json`.

Seventeen tables persist users, organizations, organization members, jurisdictions, permit profiles, projects, uploaded documents, document pages, official source versions, permit requirements, rulesets, review runs, findings, evidence, audit events, jobs, and AI usage. Foreign keys, deletion policies, tenant indexes, document checksums, unique processing keys, and review input hashes are in `src/schema.ts` and `migrations/`.

No existing backend was available to reuse. The initial candidate permit profile is **City of Brentwood, California / new ADU / Res New**. It is not represented as a verified government checklist.

## Authentication and production configuration

Production requires `NODE_ENV=production`, `DEMO_MODE=false`, `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, and an HTTPS `OIDC_JWKS_URL`. Only RS256/ES256 signed tokens matching the issuer, audience, and expiry are accepted. The demo token is disabled by configuration validation in production.

Provision a known issuer subject with a trusted operator shell:

```sh
BOOTSTRAP_SUBJECT='known-issuer-subject' \
BOOTSTRAP_EMAIL='owner@example.com' \
BOOTSTRAP_ORGANIZATION='Example organization' \
BOOTSTRAP_RULE_ADMIN=true npm run bootstrap
```

The CLI prints resource IDs, not credentials. It creates an owner membership. Additional memberships currently require a trusted database/operator workflow; no self-service invitation system is implemented. Never derive memberships from arbitrary client claims. Every authenticated request sends `Authorization: Bearer <access-token>` and `X-Organization-Id: <membership-org-id>`. Membership and resource ownership are checked server-side. Roles `owner`, `admin`, and `editor` may write; other roles are read-only. Project deletion and audit-log access require owner/admin. Government-rule administration additionally requires `users.rule_admin`; tenant ownership alone is insufficient.

Serve behind an HTTPS reverse proxy. Keep the service bound to loopback or a private container network, configure the exact `CORS_ORIGIN`, use a least-privilege database role, and run the process as a non-root OS user. Apply migrations with a separate deployment role. TLS termination, identity-provider setup, backups, secrets management, and monitoring are deployment responsibilities.

## Private uploads and extraction

Each upload request carries one file; repeat requests to upload multiple files into a project. MIME/signature agreement, actual PDF parsing or image decoding, byte limits, PDF page limits, and optional ClamAV scanning run before persistence. Filenames are display metadata only; object keys are server-generated UUIDs. Duplicate file bytes within a project return the existing document.

Local objects use private filesystem directories and file permissions. S3 uses the standard server-side AWS credential chain, AES256 server-side encryption, and authenticated downloads through the API. Configure bucket public-access blocking and bucket IAM in infrastructure. No public bucket or static download URL is created. S3 credentials and a live S3 service are needed to validate that adapter in deployment; local storage is the tested path.

A durable job extracts each PDF page using embedded text first and Tesseract OCR as fallback, or OCR for PNG/JPEG. Exact text, zero-based stored page indices, one-based public evidence page numbers, extraction method, and unreadable/truncated state are retained. OCR word-confidence thresholds are pipeline heuristics, not product accuracy percentages. Layout and bounding boxes are not claimed. Signatures are not verified. Multi-page images, encrypted PDFs, and other file formats are unsupported.

`MAX_UPLOAD_MB`, `MAX_PAGES`, and `MAX_PROJECT_DOCUMENTS` bound work. Parser/OCR subprocesses have timeouts and bounded output. Native document parsers should also be isolated with container memory/CPU limits and current OS patches. `CLAMAV_ENABLED=true` invokes installed `clamscan` and fails closed if scanning fails. Scanning is **off by default and was not exercised against a live malware-scanning service**.

## Review pipeline and reliability

Stages are `queued`, `extracting`, `classifying`, `checking_requirements`, `generating_findings`, `completed`, or `failed`. The UI should poll the saved run; reports are unavailable until completion. Failure is never represented as completion.

The worker claims jobs with row locks and `SKIP LOCKED`, leases and heartbeats, bounded exponential retry delays, and unique deduplication keys. Expired leases are recoverable. Page replacement and final findings/report persistence are transactional. Unchanged document IDs/checksums and input hashes avoid repeated extraction/reviews. Failed extraction can be retried using `/api/documents/:id/reprocess`; posting the same review request can retry a failed run. File deletion waits for active processing to finish.

Each review pins project metadata, document IDs/checksums, ruleset version, and optional model. Published ruleset snapshots are append-only through the API. Completed report JSON is a saved snapshot, independent of later project/rule edits. Privacy deletion is the explicit exception: derived reports are redacted and become unavailable. Reports include requirements, exact official excerpts, source versions and verification dates, source links, uploaded evidence spans, recommendations, uncertainty, and limitations.

Deterministic code handles document-category indicators, explicit labeled fields, basic address normalization, stage distinctions, and ADU-type applicability. A missing extracted value never proves a blank original field. Unreadable/unknown material prevents reliable absence checks. Positive document-category text verifies that an indicator is present, not that every page of that document is complete or legally sufficient.

## Optional AI adapter

Set `AI_ENABLED=true`, `AI_API_KEY`, HTTPS `AI_BASE_URL`, and `AI_MODEL` for an OpenAI-compatible `/chat/completions` provider with strict JSON-schema support. All calls stay server-side. The adapter has bounded per-document inputs, timeouts, transient HTTP retries, schema validation, tenant-scoped response caching, daily request reservations, token counts, and optional estimated cost using your configured prices. Unknown prices and provider-omitted usage remain null. Reservations remain charged on failed attempts to avoid retry-based budget bypasses.

Only this review's uploaded pages and already verified rules go to the provider. Documents and retrieved excerpts are explicitly untrusted input. The provider cannot add rules. Every returned span must match the saved document/page/UTF-16 offsets exactly. Invented references, values outside cited text, unsupported signature claims, and unknown rule IDs are rejected. AI-only category/field matches remain human-review interpretations; deterministic evidence has precedence. An AI outage or budget failure leaves deterministic findings available and records a report warning.

No paid live provider request was made during delivery. Provider behavior and costs require a deployment smoke test with your credentials. There is no claim that prompt-injection defenses or exact-span validation establish semantic correctness.

## Source verification and ruleset administration

See `docs/sources.md` for observed URL access results. Seeded official URLs are **candidate records only**. They contain no active government requirements. No current code edition, statutory applicability, or 2026 FAQ contents were inferred from the task prompt.

1. A global rule administrator retrieves an allowlisted official HTML URL through `/api/admin/sources/retrieve`, or manually imports exact official HTML/PDF text with the required attestation. Automated retrieval is bounded, rejects redirects and non-HTML responses, and performs no crawling.
2. Review agency, jurisdiction, document version/checksum, dates, exact contents, and currency. Verify the source through `/api/admin/sources/:id/verify`. A candidate URL alone cannot be verified.
3. Draft a requirement containing an exact substring of that saved source, a source location, application/review/issuance/other stage, structured matching and applicability, and effective filing-date interval.
4. Verify the requirement through `/api/admin/requirements/:id/verify` after human review of its meaning, matching logic, stage, and dates.
5. Publish a new ruleset version with the verified requirement IDs and filing-date interval. The publication transaction checks source/version/excerpt, jurisdiction/profile, human identities/timestamps, and date coverage. Unverified drafts and synthetic sources outside demo mode cannot activate.

Published snapshots stay fixed; publish a new version for changes. The most recently published applicable version is selected for a filing date. Historical reviews retain their old snapshots. Human review must check whether the applicable California code edition and each document remain current. A state HCD page is not automatically a Brentwood initial-submission checklist. County requirements are not imported as city requirements. Initial submission and pre-issuance declarations remain distinct.

## Deletion, retention, and operational limits

`DELETE /api/documents/:id` immediately denies downloads, redacts project review findings/reports and AI cached private responses, cancels queued extraction, and queues retryable private-object deletion. Audit events and AI budget/usage metadata remain without private text. Successful cleanup deletes pages and document metadata. Project deletion queues document cleanup and final project removal. Jobs that exhaust retries remain failed for operator attention; inspect `jobs.error_code` without logging document content.

Schedule `npm run retention` daily under your deployment scheduler. It processes at most 100 expired documents per invocation and skips active processing; run it repeatedly for a backlog. With PGlite, stop the server before the maintenance CLI; ordinary PostgreSQL supports concurrent maintenance. `RETENTION_DAYS` controls source-document retention. Infrastructure backups and S3 version retention must have their own deletion policies; logical deletion cannot guarantee erasure from external backups. A process crash between object creation and DB commit can leave an orphan object; an operational storage inventory/reconciliation task is still needed before broad production use.

Additional limits: per-process API rate limits are not a distributed rate-limit store; no automatic source freshness monitoring or ruleset revocation; English OCR only; basic labeled-field extraction and address normalization; no geometric/drawing interpretation, signature or professional-license validation, bounding boxes, code compliance, cost-savings measurement, or acceptance predictions. PDF output uses built-in fonts with limited non-Latin coverage. S3, ClamAV, live OIDC discovery/networking, and paid AI have adapters/configuration but were not verified against external production services.

## Connecting the existing frontend

Use `PermitProofClient` in `src/client.ts` with the existing identity token provider, actual API origin, and selected organization ID. Bind project creation, document lists/upload results, review creation/status polling, findings/evidence, and PDF blobs to the existing components without changing their layout or styling. Show `synthetic-demo` explicitly when configured. Handle `NO_VERIFIED_RULESET`, queued/running/failed states, extraction uncertainty, and download errors. Fetch persisted resources after refresh. Remove old fake data only when the corresponding real endpoint is wired. This integration remains pending because no frontend files were present.

The full route list, request bodies, pagination, errors, and administrator attestations are in `docs/api.md` and the generated OpenAPI contract.
