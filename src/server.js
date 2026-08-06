import "dotenv/config";
import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { createDatabase, initializeDatabase } from "./database.js";
import { runResaleMonitor } from "./resale.js";
import { closeProductPageBrowser } from "./product-page.js";
import { runEnabledPricing } from "./pricing.js";

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

let lastScheduledDate = "";
let schedulerRunning = false;
const scheduler = setInterval(async () => {
  const now = new Date();
  const beijingDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
  const beijingHour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hour12: false,
  }).format(now));
  if (beijingHour !== 10 || lastScheduledDate === beijingDate || schedulerRunning) return;
  schedulerRunning = true;
  try {
    for (const store of config.stores) await runResaleMonitor({ config, pool, store });
    lastScheduledDate = beijingDate;
    console.log(`Daily resale monitor completed for ${beijingDate}`);
  } catch (error) {
    console.error("Daily resale monitor failed", error);
  } finally {
    schedulerRunning = false;
  }
}, 60_000);

let pricingSchedulerRunning = false;
const pricingScheduler = setInterval(async () => {
  if (pricingSchedulerRunning || !pool) return;
  pricingSchedulerRunning = true;
  try {
    const result = await runEnabledPricing({ config, pool, dueOnly: true });
    if (result.results.length) console.log(`Automatic pricing checked ${result.results.length}; adjusted ${result.adjusted}`);
  } catch (error) {
    console.error("Automatic pricing scheduler failed", error);
  } finally {
    pricingSchedulerRunning = false;
  }
}, 30_000);

async function shutdown() {
  clearInterval(scheduler);
  clearInterval(pricingScheduler);
  server.close(async () => {
    await closeProductPageBrowser();
    if (pool) await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
