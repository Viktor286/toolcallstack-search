import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPostgresStore, migrate } from "./store.ts";
import { startTracing } from "./tracing.ts";

const config = loadConfig();

let store = null;
if (config.DATABASE_URL) {
  store = createPostgresStore(config.DATABASE_URL, { storeRaw: config.STORE_RAW });
  await migrate(store.sql);
}

const tracing = startTracing(process.env);
const app = await buildApp({ config, store, sql: store?.sql, tracing });
if (tracing) app.log.info("OpenTelemetry tracing is on");
if (!store) app.log.warn("DATABASE_URL is not set: search calls are logged but not stored");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
