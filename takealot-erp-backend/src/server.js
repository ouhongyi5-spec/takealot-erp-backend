import "dotenv/config";
import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { createDatabase, initializeDatabase } from "./database.js";

const config = getConfig();
const pool = createDatabase(config.databaseUrl);

try {
  await initializeDatabase(pool);
} catch (error) {
  console.error("Database initialization failed", error);
  process.exit(1);
}

const app = createApp({ config, pool });
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Takealot ERP backend listening on port ${config.port}`);
});

async function shutdown() {
  server.close(async () => {
    if (pool) await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
