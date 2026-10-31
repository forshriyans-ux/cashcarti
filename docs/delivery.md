# Delivery record

Implemented directly in the local `cashcarti` repository. The repository and its GitHub remote had no commits, branches, or frontend source when inspected. All files listed below are new. No existing UI was changed. This backend is the initial source delivery for the Cashcarti repository.

## Created files

- `src/schema.ts`, `migrations/0000_secret_umar.sql`, and `migrations/meta/`: 17 PostgreSQL tables and checked-in Drizzle migration metadata.
- `src/config.ts`, `src/db.ts`, `src/errors.ts`, `src/main.ts`: validated configuration, database drivers/migrations, standardized errors, application lifecycle.
- `src/auth.ts`, `src/service.ts`, `src/app.ts`: signed OIDC authentication or explicit demo authentication, membership/tenant authorization, project/document/review services, REST API and administration.
- `src/storage.ts`, `src/extraction.ts`: private local/S3 storage, validated PDF/image ingestion, optional ClamAV command, embedded text/OCR, page states, source-backed classification/facts.
- `src/registry.ts`, `src/engine.ts`, `src/ai.ts`, `src/worker.ts`, `src/report.ts`: human source/rule verification, versioned rulesets, conservative deterministic findings, optional evidence-validated provider adapter, durable jobs, saved JSON/PDF reports.
- `src/contracts.ts`, `src/api-types.ts`, `src/client.ts`: strict runtime schemas, serialized TypeScript API types, frontend adapter.
- `src/seed.ts`, `src/fixtures.ts`, `src/cli.ts`, `scripts/demo.mjs`: account/registry setup, synthetic PDFs/rules, migration/retention commands, full HTTP demonstration.
- `tests/unit.test.ts`, `tests/integration.test.ts`, `tests/auth.test.ts`, `tests/evaluate.ts`: regression tests and labeled synthetic evaluation.
- `README.md`, `docs/api.md`, `docs/sources.md`, `docs/openapi.json`, `scripts/generate-api.ts`: setup, architecture, security/limits, source-access observations, and generated API contract.
- `package.json`, `package-lock.json`, `tsconfig.json`, `drizzle.config.ts`, `vitest.config.ts`, `.env.example`, `.gitignore`, `.prettierrc.json`, `compose.yaml`: development/build/test/database configuration.

The local `.env` contains an independently generated demo token and is ignored by Git. Runtime databases, private objects, fixtures, and generated reports under `data/` are also ignored. No live customer documents were used.

## Persistence

Models: User, Organization, OrganizationMember, Jurisdiction, PermitProfile, Project, UploadedDocument, DocumentPage, OfficialSource, PermitRequirement, Ruleset, ReviewRun, Finding, Evidence, AuditEvent, Job, and AIUsage. PostgreSQL is the production database. Persistent PGlite supports a single-process local demo; tests also use fresh in-memory PGlite instances.

## APIs and working features

31 documented operations across 24 paths implement project CRUD, document upload/list/metadata/download/deletion/reprocessing, asynchronous review creation/history/status/findings, JSON/PDF reports, jurisdictions/profiles/published requirements, identity/health, tenant audit metadata, and global-administrator source/requirement/ruleset workflows. See the full route list in `docs/api.md` and `docs/openapi.json`.

Validated end-to-end behavior includes real private PDF uploads, duplicate handling, embedded extraction, scanned-image OCR, exact page/spans, classified document indicators, labeled field extraction, address conflict checks, potentially missing document categories, uncertain applicability, correct issuance-stage treatment, explicit unreadable states, durable idempotent jobs/retries/lease recovery, report persistence, privacy redaction, retention, and project deletion. Model-only interpretations remain human-review findings. No building-code approval or signature validation is implemented.

## Verification results

- TypeScript type checking and compiled build passed.
- 33 tests passed with embedded PostgreSQL. The production PostgreSQL 17 driver also passed the 33-test suite against a fresh local container database.
- Tests cover real uploads/extraction/review/findings/report/deletion, page and byte limits, path traversal, tenant isolation, signed JWT expiry/issuer/audience/signature checks, strict JSON/evidence validation, source verification/publication, failed processing/retry, AI failure/budgets, retention, and lease recovery.
- Labeled deterministic evaluation: 3 synthetic cases; 1 correctly identified omission; 0 false-positive omissions; 0 false-negative omissions; 19 of 19 evidence references matched exact saved spans; 8 of 8 expected abstentions matched; 0 case mismatches. This is a small synthetic regression evaluation, not a model accuracy estimate.
- The HTTP demo created a project, uploaded two PDFs, completed a real review, and downloaded real JSON/PDF reports. The report had 3 verified-present indicators/fields, 1 potentially missing item, 2 human-review items, 1 not-applicable issuance item, and 1 address inconsistency. Its persisted project and report remained readable after a server restart.
- The PDF was parsed with Poppler and its synthetic labeling, evidence, limitations, and findings were checked in extracted text.
- Full `npm audit` reported zero vulnerabilities after dependency updates and a patched esbuild override. Drizzle migration generation was checked with that override.

## Official-source support and remaining work

The official registry and human verification/publication workflow are implemented and tested. **No live Brentwood government rules ship activated.** All four supplied Brentwood pages returned HTTP 403 during browser verification. The HCD state ADU page was accessible but was not interpreted as a local submission checklist. The 2026 city FAQ contents and code-edition claims were not independently retrieved. Source URLs remain candidates. The demonstration uses explicitly fictional requirements and a distinct synthetic source.

The existing frontend was absent, so its screens could not be connected or visually tested. The typed adapter is supplied; UI integration remains pending until that source is added.

External production setup requires PostgreSQL credentials, OIDC issuer/audience/JWKS plus provisioned memberships, private object storage credentials if S3 is chosen, and an AI API key only if optional semantic analysis is enabled. S3, live identity-provider networking, ClamAV, and paid provider calls were not tested against external services. Retention scheduling, backup erasure policies, parser resource isolation, source freshness review, and orphan-object reconciliation need deployment operations. Self-service membership management and user-facing job cancellation are not implemented. English OCR, basic text heuristics, limited PDF font coverage, and per-process HTTP rate limits are MVP limitations.

## Exact launch and test commands

Fresh setup, after installing Node 24+, Poppler, and English Tesseract:

```sh
cd /workspace/cashcarti
npm ci
cp .env.example .env
# Replace DEMO_TOKEN in .env with a random value of at least 32 characters.
npm run db:migrate
npm run demo:seed
npm run dev
```

Run the demonstration in a second terminal:

```sh
cd /workspace/cashcarti
npm run demo:run
```

For this workspace, `.env`, the local database, and synthetic fixtures have already been prepared. The API listens at `http://127.0.0.1:3001` when started. Generated demonstration reports are `data/generated/synthetic-report.json` and `data/generated/synthetic-report.pdf`.

```sh
npm run typecheck
npm test
npm run evaluate
npm run build
npm audit
```

The README contains production configuration, optional PostgreSQL Compose setup, administration steps, and integration instructions.
