import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { connectDatabase } from './db.js';
import { provision, seedRegistry, seedDemo } from './seed.js';
import { Service } from './service.js';
import { storage } from './storage.js';
import { SYNTHETIC_PACKET, syntheticPDF } from './fixtures.js';
import { z } from 'zod';
const c = loadConfig();
const database = await connectDatabase(c);
try {
  const action = process.argv[2];
  if (action === 'migrate') {
    await database.migrate();
    console.log('Database migrations applied.');
  } else if (action === 'bootstrap') {
    const subject = z.string().min(1).parse(process.env.BOOTSTRAP_SUBJECT);
    const email = z.string().email().parse(process.env.BOOTSTRAP_EMAIL);
    const result = await provision(
      database.db,
      subject,
      email,
      process.env.BOOTSTRAP_ORGANIZATION ?? 'PermitProof Organization',
      process.env.BOOTSTRAP_RULE_ADMIN === 'true',
    );
    const { profile, jurisdiction } = await seedRegistry(database.db);
    console.log(
      JSON.stringify({
        organizationId: result.organizationId,
        userId: result.user.id,
        profileId: profile.id,
        jurisdictionId: jurisdiction.id,
      }),
    );
  } else if (action === 'demo') {
    const result = await seedDemo(database.db, c);
    await mkdir('./data/synthetic-packet', { recursive: true });
    for (const f of SYNTHETIC_PACKET)
      await writeFile(`./data/synthetic-packet/${f.filename}`, await syntheticPDF(f.lines), {
        mode: 0o600,
      });
    const context = {
      mode: 'SYNTHETIC DEMO ONLY',
      organizationId: result.actor.organizationId,
      jurisdictionId: result.jurisdiction.id,
      permitProfileId: result.profile.id,
      packetDirectory: './data/synthetic-packet',
    };
    await writeFile('./data/demo-context.json', JSON.stringify(context, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(context));
  } else if (action === 'retention') {
    console.log(
      JSON.stringify({
        expiredDocumentsConsidered: await new Service(database.db, c, storage(c)).retention(),
      }),
    );
  } else throw new Error('Use migrate, bootstrap, demo, or retention');
} finally {
  await database.close();
}
