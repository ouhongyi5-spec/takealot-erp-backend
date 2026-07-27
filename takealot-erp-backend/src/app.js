import cors from "cors";
import express from "express";
import { missingRequiredConfig } from "./config.js";
import { storeSyncRun, storeWebhook } from "./database.js";
import { takealotRequest } from "./takealot.js";
import { verifyWebhookSignature } from "./webhook.js";

function getEventType(payload) {
  return payload?.event || payload?.event_type || payload?.type || null;
}

export function createApp({ config, pool = null }) {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    cors({
      origin: config.frontendUrl ? [config.frontendUrl] : false,
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.get("/", (_req, res) => {
    res.json({
      service: "Takealot ERP Backend",
      status: "ok",
      documentation: "/health",
    });
  });

  app.get("/health", async (_req, res) => {
    const missing = missingRequiredConfig(config);
    if (missing.length) {
      return res.status(503).json({ status: "misconfigured", missing });
    }

    const result = await takealotRequest(config, "seller");
    return res.status(result.ok ? 200 : result.status).json({
      status: result.ok ? "connected" : "disconnected",
      takealotStatus: result.status,
      seller: result.ok ? result.data : undefined,
      error: result.ok ? undefined : result.data,
      database: pool ? "configured" : "not_configured",
    });
  });

  app.get("/api/takealot/health", async (_req, res) => {
    const result = await takealotRequest(config, "seller");
    return res.status(result.ok ? 200 : result.status).json({
      connected: result.ok,
      status: result.status,
      data: result.data,
    });
  });

  app.get("/api/takealot/inventory", async (req, res) => {
    const params = new URLSearchParams(req.query);
    params.append("expands", "seller_warehouse_stock");
    params.append("expands", "takealot_warehouse_stock");
    const result = await takealotRequest(config, "offers", { searchParams: params });
    return res.status(result.status).json(result.data);
  });

  app.get("/api/takealot/:resource", async (req, res) => {
    const result = await takealotRequest(config, req.params.resource, {
      searchParams: new URLSearchParams(req.query),
    });
    return res.status(result.status).json(result.data);
  });

  app.post("/api/takealot/sync", async (_req, res) => {
    const results = {};
    for (const resource of ["offers", "sales"]) {
      const params = new URLSearchParams({ limit: "100", include_count: "true" });
      const result = await takealotRequest(config, resource, { searchParams: params });
      results[resource] = result;
      await storeSyncRun(pool, resource, result);
    }

    const ok = Object.values(results).every((result) => result.ok);
    return res.status(ok ? 200 : 502).json({ ok, results });
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
