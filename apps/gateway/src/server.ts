import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPostgresStore, migrate } from "./store.ts";

const config = loadConfig();

let store = null;
if (config.DATABASE_URL) {
  store = createPostgresStore(config.DATABASE_URL, { storeRaw: config.STORE_RAW });
  await migrate(store.sql);
}

const app = await buildApp({ config, store });
if (!store) app.log.warn("DATABASE_URL is not set: search calls are logged but not stored");
if (config.GATEWAY_API_KEYS.length === 0) {
  app.log.warn(
    "GATEWAY_API_KEYS is not set: the API is open to anyone who can reach this port, and every call spends provider credits",
  );
}

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
