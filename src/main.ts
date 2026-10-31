import { loadConfig } from './config.js';
import { connectDatabase } from './db.js';
import { storage } from './storage.js';
import { buildApp } from './app.js';
const c = loadConfig();
const database = await connectDatabase(c);
const { app } = await buildApp(c, database.db, storage(c));
app.addHook('onClose', async () => database.close());
await app.listen({ host: c.HOST, port: c.PORT });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close();
  });
