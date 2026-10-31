import type { Rule, ReviewDocument, Fact, FindingResult } from './contracts.js';
import { verifySpan } from './extraction.js';
export function normalizeAddress(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\blane\b/g, 'ln')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\bcalifornia\b/g, 'ca')
    .replace(/\s+/g, ' ')
    .trim();
}
export function applicability(rule: Rule, facts: Fact[]): 'yes' | 'no' | 'unknown' {
  if (!rule.applicability.aduType) return 'yes';
  const values = new Set(
    facts.filter((f) => f.field === 'aduType').map((f) => f.value.toLowerCase()),
  );
  if (
    values.size !== 1 ||
    [...values].some((v) => !['attached', 'detached', 'conversion'].includes(v))
  )
    return 'unknown';
  return values.has(rule.applicability.aduType) ? 'yes' : 'no';
}
export function evaluate(rules: Rule[], docs: ReviewDocument[]): FindingResult[] {
  const allPages = docs.flatMap((d) => d.pages);
  const facts = docs.flatMap((d) => d.facts).filter((f) => verifySpan(f.evidence, allPages));
  const unreadable = docs.some(
    (d) =>
      d.extractionStatus !== 'completed' ||
      d.pages.length === 0 ||
      d.pages.some((p) => p.status !== 'readable'),
  );
  const unknown = docs.some((d) => d.classification.type === 'unknown');
  const out: FindingResult[] = rules.map((rule) => {
    const base: FindingResult = {
      requirementId: rule.id,
      sourceId: rule.sourceId,
      category: 'Unable to determine',
      severity: rule.severity,
      explanation:
        'The available evidence does not establish whether this requirement is satisfied.',
      suggestedAction:
        'Ask a qualified reviewer to check the source requirement against the original packet.',
      evidence: [],
      interpretation: 'deterministic',
    };
    if (rule.stage !== 'application')
      return {
        ...base,
        category: 'Not applicable',
        explanation: `This is an ${rule.stage}-stage requirement and is not evaluated as an initial application omission.`,
        suggestedAction: 'Check this requirement at the applicable permit stage.',
      };
    const applies = applicability(rule, facts);
    if (applies === 'no')
      return {
        ...base,
        category: 'Not applicable',
        explanation:
          'The extracted ADU type does not match this requirement’s applicability condition.',
      };
    if (applies === 'unknown')
      return {
        ...base,
        category: 'Needs human review',
        explanation:
          'The applicable ADU type could not be established consistently from the packet.',
      };
    if (rule.matching.kind === 'document_type') {
      const type = rule.matching.documentType;
      const selected = docs.filter((d) => d.classification.type === type);
      const matched = selected
        .flatMap((d) => d.classification.evidence)
        .filter((s) => verifySpan(s, allPages));
      if (matched.length && selected.every((d) => d.classification.method === 'ai'))
        return {
          ...base,
          category: 'Needs human review',
          interpretation: 'ai',
          explanation:
            'AI identified text that may indicate the requested document category. Confirm the classification in the original upload.',
          evidence: matched,
        };
      if (matched.length)
        return {
          ...base,
          category: 'Verified present',
          explanation:
            'Text identifying the requested document category is present. This does not verify all contents of that document.',
          suggestedAction: 'Confirm that the identified document is complete and current.',
          evidence: matched,
        };
      if (!unreadable && !unknown)
        return {
          ...base,
          category: 'Potentially missing',
          explanation:
            'No uploaded document was identified as the requested category in the readable packet.',
          suggestedAction: 'Confirm whether this document is included; supply it if required.',
        };
      return {
        ...base,
        explanation:
          'Unreadable, unprocessed, or unclassified documents prevent a reliable absence check.',
      };
    }
    if (rule.matching.kind === 'field') {
      const field = rule.matching.field;
      const found = facts.filter((f) => f.field === field);
      if (found.length)
        return {
          ...base,
          category: found.every((f) => f.method === 'ai')
            ? 'Needs human review'
            : 'Verified present',
          interpretation: found.every((f) => f.method === 'ai') ? 'ai' : 'deterministic',
          explanation:
            'The requested field has a source-backed extracted value; its correctness has not been independently verified.',
          suggestedAction: 'Check the cited value against the original document.',
          evidence: found.map((f) => f.evidence),
        };
      return {
        ...base,
        category: unreadable ? 'Unable to determine' : 'Needs human review',
        explanation:
          'No reliable value for the requested field was extracted. This does not prove the original field is blank.',
        suggestedAction: 'Inspect this field in the original documents and complete it if needed.',
      };
    }
    return {
      ...base,
      explanation: 'This requirement needs semantic interpretation or a qualified human review.',
    };
  });
  const addresses = facts.filter((f) => f.field === 'projectAddress');
  const values = new Set(addresses.map((f) => normalizeAddress(f.value)));
  if (values.size > 1)
    out.push({
      category: 'Inconsistent information',
      severity: 'warning',
      explanation:
        'Explicit project-address fields contain different normalized values. Formatting normalization is limited and the difference requires confirmation.',
      suggestedAction: 'Reconcile the cited project addresses across the packet.',
      evidence: addresses.map((f) => f.evidence),
      interpretation: 'deterministic',
    });
  if (unreadable)
    out.push({
      category: 'Unable to determine',
      severity: 'warning',
      explanation:
        'One or more pages are unreadable, truncated, or failed extraction. Absence checks affected by those pages remain unresolved.',
      suggestedAction: 'Upload a readable copy and run a new review.',
      evidence: [],
      interpretation: 'deterministic',
    });
  return out;
}
