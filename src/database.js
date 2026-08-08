import pg from "pg";

const { Pool } = pg;

export function createDatabase(databaseUrl) {
  if (!databaseUrl) return null;

  return new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

export async function initializeDatabase(pool) {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT,
      payload JSONB NOT NULL,
      signature TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id BIGSERIAL PRIMARY KEY,
      resource TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      successful BOOLEAN NOT NULL,
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS resale_monitor_results (
      store_id TEXT NOT NULL,
      offer_id BIGINT NOT NULL,
      productline_id BIGINT,
      sku TEXT,
      title TEXT,
      image_url TEXT,
      product_url TEXT,
      status TEXT NOT NULL,
      own_rank INTEGER,
      own_price INTEGER,
      competitors JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (store_id, offer_id)
    );

    CREATE TABLE IF NOT EXISTS resale_monitor_history (
      id BIGSERIAL PRIMARY KEY,
      store_id TEXT NOT NULL,
      offer_id BIGINT NOT NULL,
      status TEXT NOT NULL,
      own_rank INTEGER,
      own_price INTEGER,
      competitors JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS resale_history_store_checked_idx
      ON resale_monitor_history (store_id, checked_at DESC);

    CREATE TABLE IF NOT EXISTS pricing_rules (
      store_id TEXT NOT NULL,
      offer_id BIGINT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      interval_minutes INTEGER NOT NULL DEFAULT 10,
      min_price INTEGER NOT NULL,
      max_price INTEGER NOT NULL,
      undercut_by INTEGER NOT NULL DEFAULT 1,
      max_change INTEGER NOT NULL DEFAULT 20,
      next_run_at TIMESTAMPTZ,
      last_run_at TIMESTAMPTZ,
      last_result TEXT,
      last_status TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (store_id, offer_id),
      CHECK (interval_minutes IN (5, 10))
    );
    CREATE INDEX IF NOT EXISTS pricing_rules_due_idx
      ON pricing_rules (enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS market_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_zh TEXT,
      seed_plid TEXT NOT NULL,
      category_path JSONB NOT NULL DEFAULT '[]'::jsonb,
      total_found INTEGER NOT NULL DEFAULT 0,
      next_cursor TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      collected_count INTEGER NOT NULL DEFAULT 0,
      last_collected_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      next_update_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS market_categories_due_idx
      ON market_categories (status, next_update_at, updated_at);

    CREATE TABLE IF NOT EXISTS market_products (
      plid TEXT PRIMARY KEY,
      tsin TEXT,
      category_id TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      brand TEXT,
      image_url TEXT,
      product_url TEXT,
      price NUMERIC,
      listing_price NUMERIC,
      rating NUMERIC,
      reviews INTEGER,
      in_stock BOOLEAN,
      stock_status TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS market_products_category_idx
      ON market_products (category_id, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS market_product_snapshots (
      plid TEXT NOT NULL,
      snapshot_date DATE NOT NULL,
      price NUMERIC,
      listing_price NUMERIC,
      rating NUMERIC,
      reviews INTEGER,
      in_stock BOOLEAN,
      stock_status TEXT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (plid, snapshot_date)
    );
  `);

  await pool.query(
    `INSERT INTO market_categories (id,name,name_zh,seed_plid,status)
     VALUES ('seed-vacuum-sealers','Vacuum Sealers','封口机','PLID98517065','pending'),
            ('seed-game-controllers','Game Controllers','游戏手柄','PLID100978533','pending')
     ON CONFLICT (id) DO NOTHING`,
  );
}

export async function storeWebhook(pool, eventType, payload, signature) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO webhook_events (event_type, payload, signature)
     VALUES ($1, $2::jsonb, $3)`,
    [eventType || null, JSON.stringify(payload), signature || null],
  );
}

export async function storeSyncRun(pool, resource, result) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO sync_runs (resource, status_code, successful, response)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [resource, result.status, result.ok, JSON.stringify(result.data)],
  );
}

export async function saveResaleResult(pool, result) {
  if (!pool) return;
  const values = [
    result.store_id, result.offer_id, result.productline_id, result.sku, result.title,
    result.image_url, result.product_url, result.status, result.own_rank, result.own_price,
    JSON.stringify(result.competitors || []), result.error || null, result.checked_at,
  ];
  await pool.query(
    `INSERT INTO resale_monitor_results
      (store_id,offer_id,productline_id,sku,title,image_url,product_url,status,own_rank,own_price,competitors,error,checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
     ON CONFLICT (store_id,offer_id) DO UPDATE SET
       productline_id=excluded.productline_id,sku=excluded.sku,title=excluded.title,
       image_url=excluded.image_url,product_url=excluded.product_url,status=excluded.status,
       own_rank=excluded.own_rank,own_price=excluded.own_price,competitors=excluded.competitors,
       error=excluded.error,checked_at=excluded.checked_at`,
    values,
  );
  await pool.query(
    `INSERT INTO resale_monitor_history
      (store_id,offer_id,status,own_rank,own_price,competitors,error,checked_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [
      result.store_id, result.offer_id, result.status, result.own_rank, result.own_price,
      JSON.stringify(result.competitors || []), result.error || null, result.checked_at,
    ],
  );
}

export async function listResaleResults(pool, storeId) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT store_id,offer_id,productline_id,sku,title,image_url,product_url,status,
            own_rank,own_price,competitors,error,checked_at
      FROM resale_monitor_results
      WHERE store_id=$1
      ORDER BY CASE
        WHEN status='followed' THEN 0
        WHEN status='clear' THEN 1
        WHEN status='error' AND (error ILIKE '%429%' OR error LIKE '%请求受限%') THEN 2
        ELSE 3
      END,
      checked_at DESC`,
    [storeId],
  );
  return result.rows;
}

export async function listPricingRules(pool, storeId) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT store_id,offer_id,enabled,interval_minutes,min_price,max_price,undercut_by,max_change,
            next_run_at,last_run_at,last_result,last_status,updated_at
       FROM pricing_rules WHERE store_id=$1 ORDER BY updated_at DESC`,
    [storeId],
  );
  return result.rows;
}

export async function savePricingRule(pool, rule) {
  if (!pool) throw new Error("PostgreSQL 未配置，无法启用后台自动竞价");
  const result = await pool.query(
    `INSERT INTO pricing_rules
       (store_id,offer_id,enabled,interval_minutes,min_price,max_price,undercut_by,max_change,next_run_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $3 THEN NOW() ELSE NULL END,NOW())
     ON CONFLICT (store_id,offer_id) DO UPDATE SET
       enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,min_price=excluded.min_price,
       max_price=excluded.max_price,undercut_by=excluded.undercut_by,max_change=excluded.max_change,
       next_run_at=CASE WHEN excluded.enabled THEN LEAST(COALESCE(pricing_rules.next_run_at,NOW()),NOW()) ELSE NULL END,
       updated_at=NOW()
     RETURNING *`,
    [rule.store_id, rule.offer_id, rule.enabled, rule.interval_minutes, rule.min_price, rule.max_price, rule.undercut_by, rule.max_change],
  );
  return result.rows[0];
}

export async function duePricingRules(pool, limit = 20) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT * FROM pricing_rules
      WHERE enabled=TRUE AND COALESCE(next_run_at,NOW()) <= NOW()
      ORDER BY COALESCE(next_run_at,updated_at) ASC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function updatePricingRuleResult(pool, rule, result) {
  if (!pool) return;
  await pool.query(
    `UPDATE pricing_rules SET last_run_at=NOW(),last_status=$1,last_result=$2,
       next_run_at=NOW() + make_interval(mins => interval_minutes),updated_at=NOW()
     WHERE store_id=$3 AND offer_id=$4`,
    [result.status, result.message, rule.store_id, rule.offer_id],
  );
}
