import cors from "cors";
import express from "express";
import { missingRequiredConfig } from "./config.js";
import { storeSyncRun, storeWebhook } from "./database.js";
import { takealotRequest } from "./takealot.js";
import { verifyWebhookSignature } from "./webhook.js";
import { getResaleResults, runResaleMonitor, startResaleMonitor } from "./resale.js";
import { listPricingRules, pricingJob, savePricingRule, startEnabledPricing } from "./pricing.js";
import { productPageRuntimeState } from "./product-page.js";
import { marketJobState, marketLibrary, marketProduct, runMarketCollectionStep, startBoundCategoryCollectionTest, boundCategoryCollectionTestStatus } from "./market.js";
import { categoryImportAuthorized, importSellerCategoryTree, runSellerCategorySync, sellerCategoryStatus } from "./seller-categories.js";
import { categoryMatchingStatus, confirmCategoryMatch, listCategoryMatches, startCategoryMatching } from "./category-matching.js";

function getEventType(payload) {
  return payload?.event || payload?.event_type || payload?.type || null;
}

function storeConfig(config, req) {
  const storeId = req.get("X-Store-ID") || req.query?.store_id || config.stores?.[0]?.id || "store_1";
  const store = config.stores?.find((entry) => entry.id === storeId);
  if (!store) return null;
  return { ...config, apiKey: store.apiKey, webhookSecret: store.webhookSecret, storeId: store.id };
}

export function createApp({ config, pool = null }) {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    cors({
      origin: config.frontendUrl ? [config.frontendUrl] : false,
      methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Store-ID"],
    }),
  );

  app.get("/", (_req, res) => {
    res.json({
      service: "Takealot ERP Backend",
      version: "7.4.0",
      status: "ok",
      documentation: "/health",
    });
  });

  app.get("/health", async (req, res) => {
    const missing = missingRequiredConfig(config);
    if (missing.length) {
      return res.status(503).json({ status: "misconfigured", missing });
    }

    const selected = storeConfig(config, req);
    if (!selected) return res.status(503).json({ status: "misconfigured", missing: ["TAKEALOT_API_KEY"] });
    const result = await takealotRequest(selected, "seller");
    return res.status(result.ok ? 200 : result.status).json({
      status: result.ok ? "connected" : "disconnected",
      takealotStatus: result.status,
      seller: result.ok ? result.data : undefined,
      error: result.ok ? undefined : result.data,
      database: pool ? "configured" : "not_configured",
      collector: productPageRuntimeState(),
    });
  });

  app.get("/api/takealot/health", async (_req, res) => {
    const selected = storeConfig(config, _req);
    if (!selected) return res.status(404).json({ error: "Unknown store" });
    const result = await takealotRequest(selected, "seller");
    return res.status(result.ok ? 200 : result.status).json({
      connected: result.ok,
      status: result.status,
      data: result.data,
      store_id: selected.storeId,
      collector: productPageRuntimeState(),
    });
  });

  app.get("/api/takealot/stores", async (_req, res) => {
    const stores = await Promise.all((config.stores || []).map(async (store) => {
      const result = await takealotRequest({ ...config, apiKey: store.apiKey }, "seller");
      const seller = result.ok && result.data && typeof result.data === "object" ? result.data : {};
      return {
        id: store.id,
        connected: result.ok,
        display_name: seller.display_name || store.fallbackName,
        legal_name: seller.legal_name || null,
        seller_id: seller.seller_id || null,
        logo: seller.logo || null,
        error: result.ok ? null : result.data,
      };
    }));
    return res.json({ stores, count: stores.length });
  });

  app.get("/api/takealot/market/library", async (req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    try { return res.json(await marketLibrary(pool, req.query)); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "商品库加载失败" }); }
  });

  app.get("/api/takealot/market/product", async (req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    try { return res.json(await marketProduct(pool, String(req.query.plid || ""))); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "商品趋势加载失败" }); }
  });

  app.get("/api/takealot/market/status", (_req, res) => res.json({ ok: true, job: marketJobState() }));
  app.get("/api/takealot/market/category-collection-test", async (_req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    try { return res.json(await boundCategoryCollectionTestStatus(pool)); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "类目试采状态加载失败" }); }
  });
  app.post("/api/takealot/market/category-collection-test", async (_req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    try { return res.status(202).json({ ok: true, ...(await startBoundCategoryCollectionTest(pool)) }); }
    catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : "类目试采无法启动" }); }
  });
  app.post("/api/takealot/market/run-step", async (_req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    if (!config.marketCollectionEnabled) return res.status(409).json({ error: "商品采集当前已暂停：请先完善并验收最新类目树", phase: "category_first" });
    try { return res.status(202).json({ ok: true, ...(await runMarketCollectionStep(pool)) }); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "商品采集失败" }); }
  });
  app.get("/api/takealot/market/categories/status", async (_req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    try { return res.json(await sellerCategoryStatus(pool)); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "类目状态加载失败" }); }
  });
  app.post("/api/takealot/market/categories/run-step", async (_req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    try { return res.status(202).json({ ok:true,...(await runSellerCategorySync(pool, config)) }); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "类目同步失败" }); }
  });
  app.post("/api/takealot/market/categories/import", express.json({ limit: "20mb" }), async (req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    if (!categoryImportAuthorized(req, config)) return res.status(config.categoryAdminToken ? 401 : 503).json({ error: config.categoryAdminToken ? "Unauthorized" : "CATEGORY_ADMIN_TOKEN is not configured" });
    try { return res.status(201).json(await importSellerCategoryTree(pool, req.body, "seller-portal-manual-import")); }
    catch (error) { return res.status(422).json({ error: error instanceof Error ? error.message : "类目文件校验失败" }); }
  });
  app.get("/api/takealot/market/category-matches/status", async (_req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    try { return res.json(await categoryMatchingStatus(pool)); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "匹配状态加载失败" }); }
  });
  app.get("/api/takealot/market/category-matches", async (req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    try { return res.json(await listCategoryMatches(pool, req.query)); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "匹配建议加载失败" }); }
  });
  app.post("/api/takealot/market/category-matches/run", express.json({ limit: "20kb" }), async (_req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    try { return res.status(202).json({ ok: true, ...(await startCategoryMatching(pool, { resetUnconfirmed: _req.body?.reset_unconfirmed === true })) }); }
    catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : "匹配任务无法启动" }); }
  });
  app.post("/api/takealot/market/category-matches/:plid/confirm", express.json({ limit: "50kb" }), async (req, res) => {
    if (!pool) return res.status(503).json({ error: "Database not configured" });
    try { return res.json(await confirmCategoryMatch(pool, String(req.params.plid || ""), req.body)); }
    catch (error) { return res.status(422).json({ error: error instanceof Error ? error.message : "类目确认失败" }); }
  });

  app.get("/api/takealot/inventory", async (req, res) => {
    const selected = storeConfig(config, req);
    if (!selected) return res.status(404).json({ error: "Unknown store" });
    const params = new URLSearchParams(req.query);
    params.delete("store_id");
    params.append("expands", "seller_warehouse_stock");
    params.append("expands", "takealot_warehouse_stock");
    const result = await takealotRequest(selected, "offers", { searchParams: params });
    return res.status(result.status).json(result.data);
  });

  app.get("/api/takealot/resale-monitor", async (req, res) => {
    const selected = storeConfig(config, req);
    if (!selected) return res.status(404).json({ error: "Unknown store" });
    const result = await getResaleResults(pool, selected.storeId);
    return res.json(req.query?.job_only === "1" ? { job: result.job } : result);
  });

  app.post("/api/takealot/resale-monitor/run", express.json({ limit: "50kb" }), async (req, res) => {
    const selected = storeConfig(config, req);
    if (!selected) return res.status(404).json({ error: "Unknown store" });
    const store = config.stores.find((entry) => entry.id === selected.storeId);
    const allowed = new Set(["all", "followed", "clear", "not_found", "rate_limited", "error"]);
    const requested = Array.isArray(req.body?.categories) ? req.body.categories.map(String).filter((item) => allowed.has(item)) : ["all"];
    const categories = requested.length ? requested : ["all"];
    const current = (await getResaleResults(pool, selected.storeId)).job;
    if (current?.status === "running") return res.status(202).json({ ok: true, accepted: false, already_running: true, job: current });
    const job = startResaleMonitor({ config, pool, store, categories, trigger: "manual" });
    return res.status(202).json({ ok: true, accepted: true, job });
  });

  app.get("/api/takealot/pricing-rules", async (req, res) => {
    const selected = storeConfig(config, req);
    if (!selected) return res.status(404).json({ error: "Unknown store" });
    try {
      return res.json({ ok: true, items: await listPricingRules(pool, selected.storeId), job: pricingJob(selected.storeId), database: pool ? "configured" : "not_configured" });
    } catch (error) {
      return res.status(502).json({ error: error instanceof Error ? error.message : "竞价规则加载失败" });
    }
  });

  app.put("/api/takealot/pricing-rules", express.json({ limit: "100kb" }), async (req, res) => {
    const selected = storeConfig(config, req);
    if (!selected) return res.status(404).json({ error: "Unknown store" });
    const offerId = String(req.body?.offer_id || "");
    const intervalMinutes = Number(req.body?.interval_minutes ?? 10);
    const values = {
      min_price: Number(req.body?.min_price), max_price: Number(req.body?.max_price),
      undercut_by: Number(req.body?.undercut_by ?? 1), max_change: Number(req.body?.max_change ?? 20),
    };
    if (!/^\d+$/.test(offerId)) return res.status(400).json({ error: "报价 ID 无效" });
    if (![5, 10].includes(intervalMinutes)) return res.status(400).json({ error: "检测间隔只可选择 5 或 10 分钟" });
    if (!Object.values(values).every(Number.isFinite) || values.min_price < 1 || values.max_price < values.min_price || values.undercut_by < 0 || values.max_change < 1) {
      return res.status(400).json({ error: "请正确设置最低价、最高价、目标差价和单次最大调价" });
    }
    try {
      const rule = await savePricingRule(pool, { store_id: selected.storeId, offer_id: offerId, enabled: Boolean(req.body?.enabled), interval_minutes: intervalMinutes, ...values });
      return res.json({ ok: true, item: rule });
    } catch (error) {
      return res.status(502).json({ error: error instanceof Error ? error.message : "竞价规则保存失败" });
    }
  });

  app.post("/api/takealot/pricing-rules/run", async (req, res) => {
    const selected = storeConfig(config, req);
    if (!selected) return res.status(404).json({ error: "Unknown store" });
    try {
      const job = startEnabledPricing({ config, pool, storeId: selected.storeId });
      return res.status(202).json({ ok: true, accepted: true, job });
    } catch (error) {
      return res.status(502).json({ error: error instanceof Error ? error.message : "动态竞价执行失败" });
    }
  });

  app.patch("/api/takealot/offers/:offerId", express.json({ limit: "100kb" }), async (req, res) => {
    const selected = storeConfig(config, req);
    if (!selected) return res.status(404).json({ error: "Unknown store" });
    const { offerId } = req.params;
    if (!/^\d+$/.test(offerId)) return res.status(400).json({ error: "Invalid offer ID" });

    const body = {};
    for (const field of ["selling_price", "rrp", "minimum_leadtime_days"]) {
      if (req.body?.[field] == null) continue;
      const value = Number(req.body[field]);
      const valid = Number.isInteger(value) && value >= (field === "minimum_leadtime_days" ? 0 : 1);
      if (!valid) return res.status(400).json({ error: `${field} must be a valid integer` });
      body[field] = value;
    }

    if (req.body?.seller_warehouse_stock != null) {
      if (!Array.isArray(req.body.seller_warehouse_stock) || !req.body.seller_warehouse_stock.length) {
        return res.status(400).json({ error: "seller_warehouse_stock must contain at least one warehouse" });
      }
      body.seller_warehouse_stock = [];
      for (const row of req.body.seller_warehouse_stock) {
        const sellerWarehouseId = Number(row?.seller_warehouse_id);
        const quantity = Number(row?.quantity_available);
        if (!Number.isInteger(sellerWarehouseId) || sellerWarehouseId < 1 || !Number.isInteger(quantity) || quantity < 0) {
          return res.status(400).json({ error: "Warehouse ID and quantity must be valid non-negative integers" });
        }
        body.seller_warehouse_stock.push({
          seller_warehouse_id: sellerWarehouseId,
          quantity_available: quantity,
        });
      }
    }

    if (!Object.keys(body).length) return res.status(400).json({ error: "No supported update fields supplied" });

    const result = await takealotRequest(selected, "offers", {
      identifier: offerId,
      method: "PATCH",
      body,
    });
    return res.status(result.status).json(result.data);
  });

  app.get("/api/takealot/:resource", async (req, res) => {
    const selected = storeConfig(config, req);
    if (!selected) return res.status(404).json({ error: "Unknown store" });
    const params = new URLSearchParams(req.query);
    params.delete("store_id");
    const result = await takealotRequest(selected, req.params.resource, {
      searchParams: params,
    });
    return res.status(result.status).json(result.data);
  });

  app.post("/api/takealot/sync", async (req, res) => {
    const selected = storeConfig(config, req);
    if (!selected) return res.status(404).json({ error: "Unknown store" });
    const results = {};
    for (const resource of ["offers", "sales"]) {
      const params = new URLSearchParams({ limit: "100", include_count: "true" });
      const result = await takealotRequest(selected, resource, { searchParams: params });
      results[resource] = result;
      await storeSyncRun(pool, resource, result);
    }

    const ok = Object.values(results).every((result) => result.ok);
    return res.status(ok ? 200 : 502).json({ ok, results, store_id: selected.storeId });
  });

  app.post(
    "/api/webhooks/takealot",
    express.raw({ type: "*/*", limit: "2mb" }),
    async (req, res) => {
      const signature = req.get("X-Takealot-Signature") || "";
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");

      if (!verifyWebhookSignature(rawBody, config.webhookSecret, signature)) {
        return res.status(401).json({ error: "Invalid webhook signature" });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      await storeWebhook(pool, getEventType(payload), payload, signature);
      return res.status(202).json({ accepted: true });
    },
  );

  app.get("/api/events", async (_req, res) => {
    if (!pool) return res.json({ items: [], database: "not_configured" });
    const result = await pool.query(
      `SELECT id, event_type, payload, received_at
       FROM webhook_events
       ORDER BY received_at DESC
       LIMIT 100`,
    );
    return res.json({ items: result.rows });
  });

  app.use(express.json({ limit: "1mb" }));
  app.use((error, _req, res, _next) => {
    console.error("Request failed", error);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
