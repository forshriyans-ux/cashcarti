import PDFDocument from 'pdfkit';
import { LIMITATION, type ReviewReport } from './contracts.js';
// Reports are generated from the immutable saved snapshot, never from mutable live rules.
export async function reportPDF(report: ReviewReport): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margin: 45,
    info: { Title: 'PermitProof preparation report' },
  });
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
  const text = (v: string, size = 10) => pdf.fontSize(size).text(v).moveDown(0.6);
  text(
    report.synthetic
      ? 'SYNTHETIC DEMO — NOT GOVERNMENT REQUIREMENTS'
      : 'PermitProof preparation report',
    18,
  );
  text(LIMITATION);
  text(
    `Project: ${report.project.name}\nAddress: ${report.project.address ?? 'Not supplied'}\nJurisdiction: ${report.jurisdiction}\nPermit: ${report.permitCategory}\nFiling date: ${report.project.filingDate}\nReview: ${report.reviewDate}\nRuleset: ${report.rulesetVersion}\nReview ID: ${report.reviewId}`,
  );
  text(
    Object.entries(report.summary)
      .map(([category, count]) => `${category}: ${count}`)
      .join('\n'),
  );
  text('Findings', 14);
  for (const f of report.findings) {
    text(`${f.category} | ${f.severity}`, 12);
    text(f.explanation);
    text(`Next step: ${f.suggestedAction}`);
    for (const e of f.evidence)
      text(`Upload ${e.documentId}, page ${e.pageNumber}, span ${e.start}:${e.end}: ${e.text}`);
    const r = report.requirements.find((r) => r.id === f.requirementId);
    if (r)
      text(
        `Requirement: ${r.description}\nStage: ${r.stage}\nSource: ${r.sourceTitle}\n${r.sourceUrl}\nSource version: ${r.sourceVersion}\nVerified: ${r.sourceVerifiedAt ?? 'See registry'}\nLocation: ${r.location}\nSupporting text: ${r.excerpt}`,
      );
  }
  text('Uncertainty and limitations', 14);
  text(LIMITATION);
  if (report.ai.warnings.length)
    text(`AI warnings: ${report.ai.warnings.join(', ')}. Deterministic results are retained.`);
  pdf.end();
  return complete;
}
