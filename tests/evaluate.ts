import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/db.js';
import { seedDemo } from '../src/seed.js';
import { SYNTHETIC_PACKET, syntheticPDF } from '../src/fixtures.js';
import { classify, extract, extractFacts, verifySpan } from '../src/extraction.js';
import { evaluate } from '../src/engine.js';
import { ruleSchema, type ReviewDocument } from '../src/contracts.js';
const c = loadConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  DEMO_TOKEN: 'synthetic-evaluation-'.padEnd(40, 'x'),
  PGLITE_PATH: ':memory:',
});
const database = await connectDatabase(c);
try {
  await database.migrate();
  const seed = await seedDemo(database.db, c);
  const rules = z.array(ruleSchema).parse(seed.ruleset.snapshot);
  const documents: ReviewDocument[] = [];
  for (const f of SYNTHETIC_PACKET) {
    const id = randomUUID();
    const pages = await extract(await syntheticPDF(f.lines), 'application/pdf', id, c);
    documents.push({
      id,
      filename: f.filename,
      extractionStatus: 'completed',
      classification: classify(pages),
      facts: extractFacts(pages),
      pages,
    });
  }
  const base = [
    'Verified present',
    'Verified present',
    'Potentially missing',
    'Needs human review',
    'Needs human review',
    'Not applicable',
    'Verified present',
    'Inconsistent information',
  ];
  const id = randomUUID();
  const certifiedPages = await extract(
    await syntheticPDF([
      'SYNTHETIC DEMO',
      'Supporting Certification',
      'Fictional demonstration supporting document.',
    ]),
    'application/pdf',
    id,
    c,
  );
  const certification: ReviewDocument = {
    id,
    filename: 'synthetic-certification.pdf',
    extractionStatus: 'completed',
    classification: classify(certifiedPages),
    facts: [],
    pages: certifiedPages,
  };
  const unreadable: ReviewDocument = {
    id: randomUUID(),
    filename: 'synthetic-unreadable.pdf',
    extractionStatus: 'completed',
    classification: { type: 'unknown', evidence: [], method: 'unknown' },
    facts: [],
    pages: [],
  };
  const cases = [
    { name: 'synthetic omissions and conflicts', docs: documents, expected: base },
    {
      name: 'synthetic supporting document present',
      docs: [...documents, certification],
      expected: base.map((v, i) => (i === 2 ? 'Verified present' : v)),
    },
    {
      name: 'synthetic unreadable input must abstain',
      docs: [...documents, unreadable],
      expected: base
        .map((v, i) => ([2, 3].includes(i) ? 'Unable to determine' : v))
        .concat('Unable to determine'),
    },
  ];
  let correctlyIdentifiedOmissions = 0,
    falsePositiveFindings = 0,
    falseNegativeFindings = 0,
    validEvidenceReferences = 0,
    totalEvidenceReferences = 0,
    correctAbstentions = 0,
    expectedAbstentions = 0,
    mismatches = 0;
  const result = cases.map((tc) => {
    const actual = evaluate(rules, tc.docs);
    const actualCategories = actual.map((f) => f.category);
    if (JSON.stringify(actualCategories) !== JSON.stringify(tc.expected)) mismatches++;
    actual.forEach((f, i) => {
      if (f.category === 'Potentially missing') {
        if (tc.expected[i] === 'Potentially missing') correctlyIdentifiedOmissions++;
        else falsePositiveFindings++;
      }
      if (tc.expected[i] === 'Potentially missing' && f.category !== 'Potentially missing')
        falseNegativeFindings++;
      if (['Needs human review', 'Unable to determine'].includes(tc.expected[i])) {
        expectedAbstentions++;
        if (tc.expected[i] === f.category) correctAbstentions++;
      }
      for (const e of f.evidence) {
        totalEvidenceReferences++;
        if (
          verifySpan(
            e,
            tc.docs.flatMap((d) => d.pages),
          )
        )
          validEvidenceReferences++;
      }
    });
    return { name: tc.name, expected: tc.expected, actual: actualCategories };
  });
  console.log(
    JSON.stringify(
      {
        label: 'SYNTHETIC deterministic evaluation; not a model accuracy claim',
        caseCount: cases.length,
        correctlyIdentifiedOmissions,
        falsePositiveFindings,
        falseNegativeFindings,
        validEvidenceReferences,
        totalEvidenceReferences,
        correctAbstentions,
        expectedAbstentions,
        mismatches,
        cases: result,
      },
      null,
      2,
    ),
  );
  if (mismatches || validEvidenceReferences !== totalEvidenceReferences) process.exitCode = 1;
} finally {
  await database.close();
}
