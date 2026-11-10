import postgres from "postgres";
import { loadConfig } from "./config.ts";
import { migrate } from "./store.ts";

const config = loadConfig();
if (!config.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = postgres(config.DATABASE_URL, { onnotice: () => {} });
const applied = await migrate(sql);
console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "up to date");
await sql.end();
