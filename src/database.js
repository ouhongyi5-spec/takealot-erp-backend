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
  `);
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
     VALUES ($1,$2,$8,$9,$10,$11::jsonb,$12,$13)`,
    values,
  );
}

export async function listResaleResults(pool, storeId) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT store_id,offer_id,productline_id,sku,title,image_url,product_url,status,
            own_rank,own_price,competitors,error,checked_at
       FROM resale_monitor_results
      WHERE store_id=$1
      ORDER BY (status='followed') DESC, own_rank DESC NULLS FIRST, checked_at DESC`,
    [storeId],
  );
  return result.rows;
}
