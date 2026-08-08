import "dotenv/config";
import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { createDatabase, initializeDatabase } from "./database.js";
import { startResaleMonitor } from "./resale.js";
import { closeProductPageBrowser } from "./product-page.js";
import { bootstrapBundledCategoryCatalog, runSellerCategorySync } from "./seller-categories.js";

const config = getConfig();
const pool = createDatabase(config.databaseUrl);

try {
  await initializeDatabase(pool);
} catch (error) {
  console.error("Database initialization failed", error);
  process.exit(1);
}

try {
  const catalogPath = new URL("../data/takealot-categories-2026-08-08.json", import.meta.url);
  const catalogResult = await bootstrapBundledCategoryCatalog(pool, catalogPath);
  console.log("Bundled seller category catalog", catalogResult);
} catch (error) {
  console.error("Bundled seller category catalog import failed", error);
  await pool?.query(
    "UPDATE market_category_sync_state SET status='failed',phase='failed',last_error=$1,updated_at=NOW() WHERE id='takealot'",
    [error instanceof Error ? error.message : String(error)],
  ).catch(() => {});
}

const app = createApp({ config, pool });
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Takealot ERP backend listening on port ${config.port}`);
});

let lastScheduledDate = "";
let dailyStartedStores = new Set();
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
  if (dailyStartedStores.date !== beijingDate) {
    dailyStartedStores = new Set();
    dailyStartedStores.date = beijingDate;
  }
  schedulerRunning = true;
  try {
    // Daily maintenance only revisits stable no-competitor products and offers
    // whose public seller list did not contain this store. Other categories
    // remain available through the manual scoped check.
    for (const store of config.stores) {
      if (dailyStartedStores.has(store.id)) continue;
      const job = startResaleMonitor({ config, pool, store, categories: ["clear", "not_found"], trigger: "daily" });
      // If a manual scan is already running, retry this store on the next
      // scheduler tick instead of silently losing today's maintenance scan.
      if (job?.trigger === "daily") dailyStartedStores.add(store.id);
    }
    if (dailyStartedStores.size === config.stores.length) {
      lastScheduledDate = beijingDate;
      console.log(`Daily resale monitor started for ${beijingDate}`);
    }
  } catch (error) {
    console.error("Daily resale monitor failed", error);
  } finally {
    schedulerRunning = false;
  }
}, 60_000);

let marketSchedulerRunning = false;
const marketScheduler = setInterval(async () => {
  if (!pool || marketSchedulerRunning || schedulerRunning) return;
  marketSchedulerRunning = true;
  try {
    // Category structure is the only market task allowed during this phase.
    // Product collection and legacy-product matching remain explicitly paused.
    await runSellerCategorySync(pool, config);
  }
  catch (error) { console.error("Background seller category sync failed", error); }
  finally { marketSchedulerRunning = false; }
}, 30_000);

async function shutdown() {
  clearInterval(scheduler);
  clearInterval(marketScheduler);
  server.close(async () => {
    await closeProductPageBrowser();
    if (pool) await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
