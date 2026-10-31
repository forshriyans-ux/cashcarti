import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as pgDrizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as liteDrizzle } from 'drizzle-orm/pglite';
import { migrate as pgMigrate } from 'drizzle-orm/node-postgres/migrator';
import { migrate as liteMigrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema.js';
import type { Config } from './config.js';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
export type DB = NodePgDatabase<typeof schema>;
export async function connectDatabase(c: Pick<Config, 'DATABASE_URL' | 'PGLITE_PATH'>) {
  if (c.DATABASE_URL) {
    const pool = new Pool({ connectionString: c.DATABASE_URL, max: 10 });
    const db = pgDrizzle(pool, { schema });
    return {
      db,
      migrate: () => pgMigrate(db, { migrationsFolder: './migrations' }),
      close: () => pool.end(),
    };
  }
  if (c.PGLITE_PATH !== ':memory:')
    await mkdir(dirname(resolve(c.PGLITE_PATH)), { recursive: true, mode: 0o700 });
  const client = new PGlite(c.PGLITE_PATH === ':memory:' ? undefined : c.PGLITE_PATH);
  await client.waitReady;
  const db = liteDrizzle(client, { schema });
  return {
    db: db as unknown as DB,
    migrate: () => liteMigrate(db, { migrationsFolder: './migrations' }),
    close: () => client.close(),
  };
}
