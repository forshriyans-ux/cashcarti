import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
if (process.env.DEMO_MODE !== 'true')
  throw new Error('This script requires explicit DEMO_MODE=true');
const context = JSON.parse(await readFile('./data/demo-context.json', 'utf8'));
const base = process.env.DEMO_API_URL ?? 'http://127.0.0.1:3001';
const headers = {
  authorization: `Bearer ${process.env.DEMO_TOKEN}`,
  'x-organization-id': context.organizationId,
};
async function request(path, init = {}) {
  const response = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response;
}
const project = await (
  await request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'SYNTHETIC ADU demo packet',
      jurisdictionId: context.jurisdictionId,
      permitProfileId: context.permitProfileId,
      filingDate: '2026-10-01',
    }),
  })
).json();
for (const filename of ['synthetic-application.pdf', 'synthetic-plans.pdf']) {
  const body = new FormData();
  body.set(
    'file',
    new Blob([await readFile(`./data/synthetic-packet/${filename}`)], { type: 'application/pdf' }),
    filename,
  );
  await request(`/api/projects/${project.id}/documents`, { method: 'POST', body });
}
const { review } = await (
  await request(`/api/projects/${project.id}/reviews`, { method: 'POST' })
).json();
let previous;
for (let i = 0; i < 90; i++) {
  const status = await (await request(`/api/reviews/${review.id}`)).json();
  if (status.stage !== previous) {
    console.log(status.stage);
    previous = status.stage;
  }
  if (status.status === 'failed') throw new Error(`Review failed: ${status.errorCode}`);
  if (status.status === 'completed') {
    await mkdir('./data/generated', { recursive: true });
    const report = await (await request(`/api/reviews/${review.id}/report`)).json();
    await writeFile('./data/generated/synthetic-report.json', JSON.stringify(report, null, 2));
    await writeFile(
      './data/generated/synthetic-report.pdf',
      Buffer.from(await (await request(`/api/reviews/${review.id}/report.pdf`)).arrayBuffer()),
    );
    console.log(
      JSON.stringify(
        {
          projectId: project.id,
          reviewId: review.id,
          summary: report.summary,
          report: 'data/generated/synthetic-report.pdf',
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
throw new Error(
  'Review has not completed within the demo polling window; inspect its real server status',
);
