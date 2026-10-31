import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { projectInput, projectPatch, reportSchema } from '../src/contracts.js';
import { sourceImport, requirementInput } from '../src/registry.js';
const paths: Record<string, Record<string, unknown>> = {};
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const page = [
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
  },
  {
    name: 'offset',
    in: 'query',
    schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
  },
];
const json = (schema: unknown) => ({ 'application/json': { schema } });
function route(
  method: string,
  path: string,
  description: string,
  options: {
    body?: unknown;
    list?: boolean;
    status?: number;
    response?: unknown;
    public?: boolean;
    binary?: boolean;
    query?: unknown[];
  } = {},
) {
  const response = options.binary
    ? { 'application/pdf': { schema: { type: 'string', format: 'binary' } } }
    : json(options.response ?? { type: 'object' });
  const operation: any = {
    summary: description,
    security: options.public ? [] : [{ BearerAuth: [] }],
    parameters: [
      ...(options.public
        ? []
        : [
            {
              name: 'X-Organization-Id',
              in: 'header',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ]),
      ...(path.includes('{id}') ? [id] : []),
      ...(options.list ? page : []),
      ...(options.query ?? []),
    ],
    responses: {
      [options.status ?? 200]: { description: 'Success', content: response },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 413, 415, 422, 429, 500].map((s) => [
          s,
          {
            description: 'Standard error',
            content: json({ $ref: '#/components/schemas/ApiError' }),
          },
        ]),
      ),
    },
  };
  if (options.body) operation.requestBody = { required: true, content: json(options.body) };
  (paths[path] ??= {})[method] = operation;
}
route('get', '/api/health', 'Health and explicit runtime mode', { public: true });
route('get', '/api/me', 'Resolved membership and runtime mode');
route('get', '/api/jurisdictions', 'Jurisdiction candidates', { list: true });
route('get', '/api/permit-types', 'Permit profile candidates', { list: true });
route('get', '/api/permit-requirements', 'Published versioned ruleset snapshots', {
  list: true,
  query: [
    { name: 'profileId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
  ],
});
route('post', '/api/projects', 'Create a persisted project', {
  status: 201,
  body: { $ref: '#/components/schemas/ProjectInput' },
});
route('get', '/api/projects', 'List projects belonging to the selected organization', {
  list: true,
});
route('get', '/api/projects/{id}', 'Read an authorized project');
route('patch', '/api/projects/{id}', 'Update project metadata', {
  body: { $ref: '#/components/schemas/ProjectPatch' },
});
route('delete', '/api/projects/{id}', 'Queue private project deletion', { status: 202 });
route('post', '/api/projects/{id}/documents', 'Upload one file; repeat for multiple documents', {
  status: 202,
});
(paths['/api/projects/{id}/documents'].post as any).requestBody = {
  required: true,
  content: {
    'multipart/form-data': {
      schema: {
        type: 'object',
        required: ['file'],
        additionalProperties: false,
        properties: {
          file: {
            type: 'string',
            format: 'binary',
            description: 'PDF, PNG, JPEG; signature and MIME must agree',
          },
        },
      },
    },
  },
};
route('get', '/api/projects/{id}/documents', 'List documents without private storage keys', {
  list: true,
});
route('get', '/api/documents/{id}', 'Read metadata and paginated page extraction statuses', {
  list: true,
});
route(
  'delete',
  '/api/documents/{id}',
  'Deny downloads and queue private object/derived-data deletion',
  { status: 202 },
);
route('post', '/api/documents/{id}/reprocess', 'Retry failed extraction', { status: 202 });
route('get', '/api/documents/{id}/download', 'Authorized attachment download');
(paths['/api/documents/{id}/download'].get as any).responses['200'] = {
  description: 'Original private file',
  content: Object.fromEntries(
    ['application/pdf', 'image/png', 'image/jpeg'].map((t) => [
      t,
      { schema: { type: 'string', format: 'binary' } },
    ]),
  ),
};
route(
  'post',
  '/api/projects/{id}/reviews',
  'Queue a review of a pinned document/ruleset snapshot',
  { status: 202 },
);
route('get', '/api/projects/{id}/reviews', 'List saved runs', { list: true });
route('get', '/api/reviews/{id}', 'Read actual status and processing stage');
route('get', '/api/reviews/{id}/findings', 'Read completed findings and exact evidence', {
  list: true,
});
route('get', '/api/reviews/{id}/report', 'Download saved JSON report', {
  response: { $ref: '#/components/schemas/ReviewReport' },
});
route('get', '/api/reviews/{id}/report.pdf', 'Download generated PDF from saved report', {
  binary: true,
});
route('get', '/api/audit-events', 'Owner/admin tenant audit metadata', { list: true });
route('get', '/api/admin/sources', 'Global rule administrator: saved source versions', {
  list: true,
});
route(
  'post',
  '/api/admin/sources/retrieve',
  'Retrieve an allowlisted official HTML source as an inactive candidate',
  {
    status: 201,
    body: {
      type: 'object',
      required: ['url', 'jurisdictionId', 'agency'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', format: 'uri' },
        jurisdictionId: { type: 'string', format: 'uuid' },
        agency: { type: 'string' },
      },
    },
  },
);
route(
  'post',
  '/api/admin/sources/import',
  'Manually attest and import exact official HTML/PDF text as inactive candidate',
  { status: 201, body: { $ref: '#/components/schemas/SourceImport' } },
);
route('post', '/api/admin/sources/{id}/verify', 'Human source verification', {
  body: {
    type: 'object',
    required: ['attestation'],
    additionalProperties: false,
    properties: {
      attestation: {
        const:
          'I checked the official URL, exact text, currency, jurisdiction, and effective date.',
      },
    },
  },
});
route(
  'get',
  '/api/admin/requirements',
  'Global rule administrator: draft and verified requirements',
  { list: true },
);
route('post', '/api/admin/requirements', 'Draft a requirement with exact saved source excerpt', {
  status: 201,
  body: { $ref: '#/components/schemas/RequirementInput' },
});
route('post', '/api/admin/requirements/{id}/verify', 'Human requirement verification', {
  body: {
    type: 'object',
    required: ['attestation'],
    additionalProperties: false,
    properties: {
      attestation: {
        const:
          'I verified the exact excerpt, stage, applicability, matching logic, and filing-date interval.',
      },
    },
  },
});
route('post', '/api/admin/rulesets', 'Publish a fixed snapshot of human-verified requirements', {
  status: 201,
  body: {
    type: 'object',
    required: ['profileId', 'version', 'requirementIds', 'effectiveFrom'],
    additionalProperties: false,
    properties: {
      profileId: { type: 'string', format: 'uuid' },
      version: { type: 'string', maxLength: 100 },
      requirementIds: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
        items: { type: 'string', format: 'uuid' },
      },
      effectiveFrom: { type: 'string', format: 'date' },
      effectiveTo: { type: 'string', format: 'date' },
    },
  },
});
const schema = (value: z.ZodType) => {
  const { $schema, ...rest } = z.toJSONSchema(value, { unrepresentable: 'any', io: 'input' });
  return rest;
};
const document = {
  openapi: '3.1.0',
  info: {
    title: 'PermitProof Backend',
    version: '0.1.0',
    description:
      'Evidence-backed preparation service. No production government rules ship active. Demo rules are synthetic.',
  },
  servers: [{ url: 'http://127.0.0.1:3001' }],
  paths,
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT (or explicit non-production demo token)',
      },
    },
    schemas: {
      ProjectInput: schema(projectInput),
      ProjectPatch: schema(projectPatch),
      ReviewReport: schema(reportSchema),
      SourceImport: schema(sourceImport),
      RequirementInput: schema(requirementInput),
      ApiError: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              requestId: { type: 'string' },
              fields: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
    },
  },
};
await mkdir('./docs', { recursive: true });
await writeFile('./docs/openapi.json', JSON.stringify(document, null, 2) + '\n');
console.log(`Generated ${Object.keys(paths).length} OpenAPI paths.`);
