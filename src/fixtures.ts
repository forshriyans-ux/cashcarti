import PDFDocument from 'pdfkit';
export const SYNTHETIC_PACKET = [
  {
    filename: 'synthetic-application.pdf',
    lines: [
      'SYNTHETIC DEMO - FICTIONAL PROJECT DATA',
      'Building Permit Application',
      'Project address: 101 Fictional Oak Street, Brentwood, CA 94513',
      'Owner name: ______',
      'Applicant name: Alex Example',
      'Project description: New accessory dwelling unit for a fictional demonstration.',
      'Proposed size: 650 sq ft',
      'Date: 2026-10-01',
    ],
  },
  {
    filename: 'synthetic-plans.pdf',
    lines: [
      'SYNTHETIC DEMO - NOT FOR CONSTRUCTION',
      'Architectural Plan Set',
      'Project address: 202 Imaginary Pine Avenue, Brentwood, CA 94513',
      'Sheet ID: A1.0',
      'Project description: Fictional ADU demonstration plan cover.',
      'Date: 2026-10-01',
    ],
  },
];
export async function syntheticPDF(lines: string[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const chunks: Buffer[] = [];
  const promise = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.fontSize(12);
  for (const line of lines) doc.text(line).moveDown(0.6);
  doc.end();
  return promise;
}
