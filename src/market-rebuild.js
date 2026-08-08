const REBUILD_CONFIRMATION = "REBUILD_12207_PRODUCTS_FROM_VERIFIED_VACUUM_SEALERS_STAGE";

export const CATEGORY_BOUND_REBUILD = Object.freeze({
  id: "vacuum-sealers-rebuild-v1",
  expected_old_product_count: 12207,
  expected_staged_product_count: 397,
  public_category_id: "33636",
  public_category_name: "Vacuum Sealers",
  seller_path_names: ["HomeSmall Appliances", "Small Appliances", "Kitchen Appliances", "Vacuum Sealers"],
});

function pathNames(path) {
  return Array.isArray(path) ? path.map((node) => String(node?.name || "").trim()).filter(Boolean) : [];
}

export function validateCategoryBoundRebuild(input) {
  const problems = [];
  const test = input?.test || {};
  const expected = CATEGORY_BOUND_REBUILD;
  if (input?.collectionEnabled) problems.push("MARKET_COLLECTION_ENABLED must remain false");
  if (Number(input?.oldProductCount) !== expected.expected_old_product_count) {
    problems.push(`active library contains ${Number(input?.oldProductCount || 0)}, expected ${expected.expected_old_product_count}`);
  }
  if (Number(input?.confirmedProductCount || 0) !== 0) problems.push("active library contains manually confirmed products");
  if (test.status !== "complete") problems.push("isolated category collection test is not complete");
  for (const field of ["reported_total", "fetched_count", "unique_count"]) {
    if (Number(test[field] || 0) !== expected.expected_staged_product_count) {
      problems.push(`${field} is ${Number(test[field] || 0)}, expected ${expected.expected_staged_product_count}`);
    }
  }
  if (Number(test.duplicate_count || 0) !== 0) problems.push("isolated stage contains duplicate PLIDs");
  if (Number(test.detail_mismatch_count || 0) !== 0) problems.push("isolated stage contains category detail mismatches");
  if (Number(test.detail_sample_count || 0) < 20) problems.push("fewer than 20 product details were verified");
  if (Number(input?.stagedProductCount || 0) !== expected.expected_staged_product_count) {
    problems.push(`staging table contains ${Number(input?.stagedProductCount || 0)}, expected ${expected.expected_staged_product_count}`);
  }
  if (String(test.public_category_id || "") !== expected.public_category_id) problems.push("public category ID does not match Vacuum Sealers");
  if (String(test.public_category_name || "") !== expected.public_category_name) problems.push("public category name does not match Vacuum Sealers");
  if (JSON.stringify(pathNames(test.seller_category_path)) !== JSON.stringify(expected.seller_path_names)) {
    problems.push("seller category path does not match the approved complete path");
  }
  return { ok: problems.length === 0, problems };
}

async function currentRebuildInputs(client, collectionEnabled) {
  const counts = (await client.query(
    `SELECT COUNT(*)::int AS products,
            COUNT(*) FILTER (WHERE category_confirmed_at IS NOT NULL
                              OR (category_match_status='confirmed' AND COALESCE(category_match_method,'')<>'category_bound_collection'))::int AS confirmed
       FROM market_products`,
  )).rows[0];
  const test = (await client.query("SELECT * FROM market_collection_tests WHERE id='vacuum-sealers-v1'")).rows[0] || null;
  const staged = Number((await client.query(
    "SELECT COUNT(*)::int AS count FROM market_collection_test_products WHERE test_id='vacuum-sealers-v1'",
  )).rows[0]?.count || 0);
  return {
    collectionEnabled,
    oldProductCount: Number(counts?.products || 0),
    confirmedProductCount: Number(counts?.confirmed || 0),
    test,
    stagedProductCount: staged,
  };
}

export async function categoryBoundRebuildStatus(pool, collectionEnabled = false) {
  const inputs = await currentRebuildInputs(pool, collectionEnabled);
  const validation = validateCategoryBoundRebuild(inputs);
  const latest = (await pool.query(
    "SELECT * FROM market_rebuild_runs ORDER BY created_at DESC LIMIT 1",
  )).rows[0] || null;
  const archives = (await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM market_products_rebuild_archive) AS products,
       (SELECT COUNT(*)::int FROM market_snapshots_rebuild_archive) AS snapshots,
       (SELECT COUNT(*)::int FROM market_categories_rebuild_archive) AS categories`,
  )).rows[0];
  return {
    ok: true,
    destructive: true,
    collection_paused: !collectionEnabled,
    target: CATEGORY_BOUND_REBUILD,
    ready: validation.ok,
    problems: validation.problems,
    active_products: inputs.oldProductCount,
    staged_products: inputs.stagedProductCount,
    isolated_test: inputs.test,
    latest_run: latest,
    archived_rows: archives,
  };
}

export async function rebuildMarketLibraryFromVerifiedStage(pool, options = {}) {
  if (!pool) throw new Error("Database not configured");
  if (options.confirmation !== REBUILD_CONFIRMATION) throw new Error("Exact rebuild confirmation is required");
  if (options.collectionEnabled) throw new Error("Product collection must remain paused during rebuild");
  const runId = `${CATEGORY_BOUND_REBUILD.id}-${Date.now()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('takealot-market-library-rebuild'))");
    const inputs = await currentRebuildInputs(client, options.collectionEnabled);
    if (Number(options.expectedOldProductCount) !== CATEGORY_BOUND_REBUILD.expected_old_product_count) {
      throw new Error(`Request must declare expected_old_product_count=${CATEGORY_BOUND_REBUILD.expected_old_product_count}`);
    }
    const validation = validateCategoryBoundRebuild(inputs);
    if (!validation.ok) throw new Error(`Rebuild blocked: ${validation.problems.join("; ")}`);

    const oldSnapshots = Number((await client.query("SELECT COUNT(*)::int AS count FROM market_product_snapshots")).rows[0]?.count || 0);
    const oldCategories = Number((await client.query("SELECT COUNT(*)::int AS count FROM market_categories")).rows[0]?.count || 0);
    await client.query(
      `INSERT INTO market_rebuild_runs
        (id,status,old_product_count,old_snapshot_count,old_category_count,new_product_count,public_category_id,seller_category_id,seller_category_path,created_at,started_at)
       VALUES ($1,'running',$2,$3,$4,0,$5,$6,$7::jsonb,NOW(),NOW())`,
      [runId, inputs.oldProductCount, oldSnapshots, oldCategories, CATEGORY_BOUND_REBUILD.public_category_id,
       inputs.test.seller_category_id, JSON.stringify(inputs.test.seller_category_path)],
    );
    await client.query(
      `INSERT INTO market_products_rebuild_archive (rebuild_id,plid,product_data)
       SELECT $1,plid,to_jsonb(p) FROM market_products p`, [runId],
    );
    await client.query(
      `INSERT INTO market_snapshots_rebuild_archive (rebuild_id,plid,snapshot_date,snapshot_data)
       SELECT $1,plid,snapshot_date,to_jsonb(s) FROM market_product_snapshots s`, [runId],
    );
    await client.query(
      `INSERT INTO market_categories_rebuild_archive (rebuild_id,category_id,category_data)
       SELECT $1,id,to_jsonb(c) FROM market_categories c`, [runId],
    );

    await client.query("DELETE FROM market_product_snapshots");
    await client.query("DELETE FROM market_products");
    await client.query("DELETE FROM market_categories");

    await client.query(
      `INSERT INTO market_products
        (plid,tsin,category_id,category_path,classification_status,title,subtitle,brand,image_url,product_url,
         price,listing_price,rating,reviews,in_stock,stock_status,first_seen_at,last_seen_at,
         original_category_id,original_category_path,current_category_id,current_category_path,
         category_match_confidence,category_match_method,recommended_category_path,recommended_candidates,
         category_match_status,category_match_evidence,category_matched_at,category_confirmed_at)
       SELECT p.plid,p.tsin,p.public_category_id,p.seller_category_path,'mapped',p.title,p.subtitle,p.brand,p.image_url,p.product_url,
         p.price,p.listing_price,p.rating,p.reviews,p.in_stock,p.stock_status,p.collected_at,p.collected_at,
         p.public_category_id,p.seller_category_path,p.seller_category_id,p.seller_category_path,
         100,'category_bound_collection','[]'::jsonb,'[]'::jsonb,'confirmed',
         jsonb_build_array('采集任务已绑定唯一卖家后台完整类目路径'),p.collected_at,p.collected_at
       FROM market_collection_test_products p WHERE p.test_id='vacuum-sealers-v1'`,
    );
    await client.query(
      `INSERT INTO market_product_snapshots
        (plid,snapshot_date,price,listing_price,rating,reviews,in_stock,stock_status,captured_at)
       SELECT plid,collected_at::date,price,listing_price,rating,reviews,in_stock,stock_status,collected_at
       FROM market_collection_test_products WHERE test_id='vacuum-sealers-v1'`,
    );
    await client.query(
      `INSERT INTO market_categories
        (id,name,name_zh,seed_plid,category_path,total_found,status,collected_count,last_collected_at,completed_at,next_update_at,updated_at)
       SELECT $1,$2,'封口机',MIN(plid),$3::jsonb,COUNT(*)::int,'complete',COUNT(*)::int,MAX(collected_at),NOW(),NULL,NOW()
       FROM market_collection_test_products WHERE test_id='vacuum-sealers-v1'`,
      [CATEGORY_BOUND_REBUILD.public_category_id, CATEGORY_BOUND_REBUILD.public_category_name,
       JSON.stringify(inputs.test.seller_category_path)],
    );
    await client.query(
      `INSERT INTO market_category_match_state
        (id,status,total_products,processed_count,recommended_count,high_count,review_count,calibration_count,confirmed_count,unmatched_count,last_error,started_at,completed_at,updated_at)
       VALUES ('takealot','category_bound_ready',$1,$1,0,0,0,0,$1,0,NULL,NOW(),NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET status=excluded.status,total_products=excluded.total_products,
         processed_count=excluded.processed_count,recommended_count=0,high_count=0,review_count=0,
         calibration_count=0,confirmed_count=excluded.confirmed_count,unmatched_count=0,last_error=NULL,
         started_at=NOW(),completed_at=NOW(),updated_at=NOW()`,
      [CATEGORY_BOUND_REBUILD.expected_staged_product_count],
    );
    await client.query(
      `UPDATE market_category_sync_state SET remapped_count=$1,pending_remap_count=0,updated_at=NOW() WHERE id='takealot'`,
      [CATEGORY_BOUND_REBUILD.expected_staged_product_count],
    );

    const verification = (await client.query(
      `SELECT COUNT(*)::int AS products,
              COUNT(*) FILTER (WHERE category_id=$1 AND current_category_id=$2
                AND category_match_method='category_bound_collection' AND category_match_status='confirmed')::int AS correctly_bound,
              COUNT(DISTINCT current_category_id)::int AS seller_categories
       FROM market_products`,
      [CATEGORY_BOUND_REBUILD.public_category_id, inputs.test.seller_category_id],
    )).rows[0];
    const newSnapshots = Number((await client.query("SELECT COUNT(*)::int AS count FROM market_product_snapshots")).rows[0]?.count || 0);
    if (Number(verification.products) !== CATEGORY_BOUND_REBUILD.expected_staged_product_count
      || Number(verification.correctly_bound) !== CATEGORY_BOUND_REBUILD.expected_staged_product_count
      || Number(verification.seller_categories) !== 1
      || newSnapshots !== CATEGORY_BOUND_REBUILD.expected_staged_product_count) {
      throw new Error("Post-rebuild verification failed; transaction will be rolled back");
    }
    await client.query(
      `UPDATE market_rebuild_runs SET status='complete',new_product_count=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [runId, CATEGORY_BOUND_REBUILD.expected_staged_product_count],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      run_id: runId,
      old_products_archived: inputs.oldProductCount,
      old_snapshots_archived: oldSnapshots,
      old_categories_archived: oldCategories,
      active_products: CATEGORY_BOUND_REBUILD.expected_staged_product_count,
      active_snapshots: newSnapshots,
      category_bound: CATEGORY_BOUND_REBUILD.expected_staged_product_count,
      collection_paused: true,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
