import cors from "cors";
import express from "express";
import { missingRequiredConfig } from "./config.js";
import { storeSyncRun, storeWebhook } from "./database.js";
import { takealotRequest } from "./takealot.js";
import { verifyWebhookSignature } from "./webhook.js";

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
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Store-ID"],
    }),
  );

  app.get("/", (_req, res) => {
    res.json({
      service: "Takealot ERP Backend",
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
