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
