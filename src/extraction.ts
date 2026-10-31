import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Config } from './config.js';
import { AppError, assert } from './errors.js';
import type { Classification, Fact, Page, Span } from './contracts.js';
const exec = promisify(execFile);
async function command(name: string, args: string[]) {
  return exec(name, args, {
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, OMP_THREAD_LIMIT: '1' },
  });
}
async function temporary<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'permitproof-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export function detectMime(data: Buffer): string | null {
  if (data.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  return null;
}
export async function validateFile(data: Buffer, claimed: string, c: Config): Promise<string> {
  const mime = detectMime(data);
  assert(
    data.length > 0 && data.length <= c.MAX_UPLOAD_MB * 1024 * 1024,
    413,
    'FILE_SIZE',
    'File exceeds configured size limit',
  );
  assert(mime && mime === claimed, 415, 'FILE_TYPE', 'Unsupported type or signature/MIME mismatch');
  try {
    await temporary(async (dir) => {
      const file = join(dir, 'input');
      await writeFile(file, data, { mode: 0o600 });
      if (c.CLAMAV_ENABLED) await command('clamscan', ['--no-summary', file]);
      if (mime === 'application/pdf') {
        const { stdout } = await command('pdfinfo', [file]);
        const count = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
        assert(
          Number.isInteger(count) && count > 0 && count <= c.MAX_PAGES,
          422,
          'PAGE_LIMIT',
          'Invalid PDF or too many pages',
        );
        assert(
          !/^Encrypted:\s+yes/m.test(stdout),
          422,
          'ENCRYPTED_PDF',
          'Encrypted PDFs are unsupported',
        );
      } else {
        const m = await sharp(data, { limitInputPixels: 25_000_000 }).metadata();
        assert(m.width && m.height && (m.pages ?? 1) === 1, 422, 'INVALID_IMAGE', 'Invalid image');
        await sharp(data, { limitInputPixels: 25_000_000 }).raw().toBuffer();
      }
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      422,
      'FILE_REJECTED',
      'File is corrupted, unsafe, or a required validation tool failed',
    );
  }
  return mime;
}
export async function extract(data: Buffer, mime: string, id: string, c: Config): Promise<Page[]> {
  return temporary(async (dir) => {
    const file = join(dir, 'input');
    await writeFile(file, data, { mode: 0o600 });
    let count = 1;
    if (mime === 'application/pdf') {
      const { stdout } = await command('pdfinfo', [file]);
      count = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    }
    assert(
      Number.isInteger(count) && count > 0 && count <= c.MAX_PAGES,
      422,
      'PAGE_LIMIT',
      'Page limit exceeded',
    );
    const result: Page[] = [];
    for (let n = 1; n <= count; n++) {
      let text = '',
        method = 'embedded',
        status = 'unreadable';
      try {
        if (mime === 'application/pdf')
          text = (
            await command('pdftotext', ['-f', String(n), '-l', String(n), '-layout', file, '-'])
          ).stdout
            .replace(/\f/g, '')
            .trim();
        if (text.replace(/\s/g, '').length < 20 && c.OCR_ENABLED) {
          let image = file;
          if (mime === 'application/pdf') {
            const prefix = join(dir, `page-${n}`);
            await command('pdftoppm', [
              '-f',
              String(n),
              '-l',
              String(n),
              '-singlefile',
              '-scale-to',
              '2200',
              '-png',
              file,
              prefix,
            ]);
            image = prefix + '.png';
          }
          const ocr = await command('tesseract', [image, 'stdout', '-l', 'eng', 'tsv']);
          const words = ocr.stdout
            .split('\n')
            .slice(1)
            .map((row) => row.split('\t'))
            .filter((cols) => cols.length >= 12 && Number(cols[10]) >= 0 && cols[11].trim());
          const avg = words.length
            ? words.reduce((s, w) => s + Number(w[10]), 0) / words.length
            : 0;
          text = words
            .map(
              (w, i) =>
                (i && words[i - 1].slice(1, 5).join(':') !== w.slice(1, 5).join(':') ? '\n' : ' ') +
                w[11],
            )
            .join('')
            .trim();
          method = 'ocr';
          status = avg >= 60 && text.replace(/\s/g, '').length >= 20 ? 'readable' : 'unreadable';
        } else status = text.replace(/\s/g, '').length >= 20 ? 'readable' : 'unreadable';
      } catch {
        status = 'unreadable';
      }
      // Text truncation is explicit; affected rules must abstain.
      if (text.length > 150000) status = 'truncated';
      result.push({ documentId: id, pageNumber: n, text: text.slice(0, 150000), method, status });
    }
    return result;
  });
}
export function span(page: Page, text: string, start = page.text.indexOf(text)): Span {
  return {
    documentId: page.documentId,
    pageNumber: page.pageNumber,
    text,
    start,
    end: start + text.length,
  };
}
export function verifySpan(s: Span, all: Page[]): boolean {
  const p = all.find((p) => p.documentId === s.documentId && p.pageNumber === s.pageNumber);
  return (
    !!p &&
    p.status === 'readable' &&
    s.start >= 0 &&
    s.end > s.start &&
    p.text.slice(s.start, s.end) === s.text
  );
}
export function classify(pages: Page[]): Classification {
  const patterns: [Classification['type'], RegExp][] = [
    ['building_permit_application', /\bbuilding permit application\b/i],
    ['architectural_plan_set', /\barchitectural (?:plan set|plans)\b/i],
    ['site_plan', /\b(?:site|plot) plan\b/i],
    ['ownership_declaration', /\b(?:owner.builder|ownership|contractor) declaration\b/i],
    ['supporting_certification', /\b(?:supporting|energy) certification\b/i],
  ];
  for (const [type, re] of patterns)
    for (const p of pages.filter((p) => p.status === 'readable')) {
      const m = p.text.match(re);
      if (m) return { type, evidence: [span(p, m[0], m.index!)], method: 'deterministic' };
    }
  return { type: 'unknown', evidence: [], method: 'unknown' };
}
export function extractFacts(pages: Page[]): Fact[] {
  const labels: [Fact['field'], RegExp][] = [
    ['projectAddress', /(?:project|site) address[ \t]*:[ \t]*([^\n\r]+)/gi],
    ['ownerName', /owner name[ \t]*:[ \t]*([^\n\r]+)/gi],
    ['applicantName', /applicant name[ \t]*:[ \t]*([^\n\r]+)/gi],
    ['projectDescription', /project description[ \t]*:[ \t]*([^\n\r]+)/gi],
    ['aduType', /adu type[ \t]*:[ \t]*(detached|attached|conversion)\b/gi],
    ['proposedSize', /proposed (?:size|area)[ \t]*:[ \t]*([\d,.]+\s*(?:sq\.?\s*ft\.?|sf))/gi],
    ['contractor', /contractor[ \t]*:[ \t]*([^\n\r]+)/gi],
    ['sheetIdentifier', /sheet\s*(?:id|number)?[ \t]*:[ \t]*([A-Z]\d[\w.-]*)/gi],
    ['date', /date[ \t]*:[ \t]*(\d{4}-\d{2}-\d{2})/gi],
  ];
  const result: Fact[] = [];
  for (const p of pages.filter((p) => p.status === 'readable'))
    for (const [field, re] of labels) {
      for (const m of p.text.matchAll(re)) {
        const value = m[1].trim();
        if (
          !value ||
          value.length > 1000 ||
          /^(?:unknown|blank|n\/a|not specified|_{2,}|-{2,})$/i.test(value)
        )
          continue;
        const start = m.index! + m[0].lastIndexOf(m[1]);
        result.push({ field, value, evidence: span(p, m[1], start) });
      }
    }
  return result;
}
