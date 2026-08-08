const PUBLIC_API_BASE = "https://api.takealot.com/rest/v-1-18-0";

const jobs = { running: false, category: null, started_at: null, last_error: null };
const categoryJob = { running: false, phase: null, started_at: null, last_error: null };
const boundTestJob = { running: false, phase: "ready", started_at: null, last_error: null };

export const BOUND_CATEGORY_TEST = Object.freeze({
  id: "vacuum-sealers-v1",
  public_category_id: "33636",
  public_category_name: "Vacuum Sealers",
  seller_path_names: ["HomeSmall Appliances", "Small Appliances", "Kitchen Appliances", "Vacuum Sealers"],
  detail_sample_size: 20,
});

const BOOK_NAMES = /^(books?|books & media|boeke|图书)$/i;
const CATEGORY_SYNC_SCHEMA = 2;

export function extractMerchandisedDepartments(payload) {
  return (Array.isArray(payload?.merchandised_departments) ? payload.merchandised_departments : [])
    .filter((item) => item?.department_id && item?.name && item?.slug)
    .map((item) => ({
      id: `department:${item.slug}`,
      name: String(item.name).trim(),
      parent_id: null,
      level: 1,
      path: [{ id:`department:${item.slug}`,name:String(item.name).trim() }],
      is_leaf: false,
      source: "navigation",
      source_path: String(item.slug),
    }));
}

function categoryIdFromParameters(parameters = {}) {
  return parameters?.search?.filters?.Category || parameters?.filters?.Category || null;
}

export function extractCmsCategoryNodes(payload, parent) {
  const nodes = [];
  const pagePaths = new Set();
  const parentPath = Array.isArray(parent?.path) ? parent.path : [];
  const add = (node) => {
    const key = `${node.id}:${node.parent_id || ""}`;
    if (!nodes.some((item) => `${item.id}:${item.parent_id || ""}` === key)) nodes.push(node);
  };
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const title = String(value.display_name || value.title || "").trim();
    const link = value.link_data || value.event;
    const parameters = link?.parameters || {};
    const categoryId = categoryIdFromParameters(parameters);
    if (title && categoryId) {
      const id = String(categoryId);
      add({ id,name:title,parent_id:parent.id,level:parent.level+1,path:[...parentPath,{id,name:title}],is_leaf:true,source:"navigation",source_path:null });
    }
    if (title && link?.action === "page") {
      const slug = String(parameters.slug || parameters.path || "").replace(/^\/+|\/+$/g, "");
      if (slug && slug !== parent.source_path && !pagePaths.has(slug)) {
        pagePaths.add(slug);
        const id = `page:${slug}`;
        add({ id,name:title,parent_id:parent.id,level:parent.level+1,path:[...parentPath,{id,name:title}],is_leaf:false,source:"navigation",source_path:slug });
      }
    }
    Object.values(value).forEach(walk);
  };
  walk(payload?.page?.widgets || []);
  return nodes;
}

export function isMissingNavigationPageError(error) {
  return /Takealot HTTP 404\b/.test(error instanceof Error ? error.message : String(error));
}

function categoryChildren(value) {
  if (!value || typeof value !== "object") return [];
  for (const key of ["children", "items", "values", "options", "subcategories", "sub_categories"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

export function extractCategoryTree(payload) {
  const roots = [];
  const seenObjects = new Set();
  const visit = (value, parent = null, path = [], categoryContext = false) => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) { value.forEach((item) => visit(item, parent, path, categoryContext)); return; }
    const label = String(value.name || value.label || value.title || "").trim();
    const id = String(value.id || value.value || value.category_id || value.slug || "").trim();
    const looksCategory = categoryContext || /categor/i.test(String(value.type || value.key || value.filter || value.name || ""));
    const children = categoryChildren(value);
    let currentParent = parent;
    let currentPath = path;
    if (looksCategory && id && label && id !== label && !/^https?:/i.test(id)) {
      const node = { id, name: label, parent_id: parent?.id || null, level: path.length + 1, path: [...path, { id, name: label }], is_leaf: children.length === 0 };
      roots.push(node); currentParent = node; currentPath = node.path;
    }
    for (const [key, child] of Object.entries(value)) visit(child, currentParent, currentPath, looksCategory || /categor/i.test(key));
  };
  visit(payload);
  return [...new Map(roots.map((node) => [node.id, node])).values()];
}

function isBookPath(path) {
  return Array.isArray(path) && path.some((node) => BOOK_NAMES.test(String(node?.name || "").trim()));
}

async function upsertCategoryNodes(pool, nodes) {
  let excluded = 0;
  for (const node of nodes) {
    const book = isBookPath(node.path); if (book) excluded += 1;
    await pool.query(
      `INSERT INTO market_category_nodes (id,name,parent_id,level,path,is_leaf,is_excluded,sync_status,source,source_path,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,level=excluded.level,
         path=excluded.path,is_leaf=excluded.is_leaf,is_excluded=excluded.is_excluded,source=excluded.source,
         source_path=excluded.source_path,updated_at=NOW()`,
      [node.id,node.name,node.parent_id,node.level,JSON.stringify(node.path),node.is_leaf,book,book || node.is_leaf ? "complete" : "pending",node.source || "navigation",node.source_path || null],
    );
  }
  return excluded;
}

export async function runCategorySyncStep(pool) {
  if (!pool || categoryJob.running) return { accepted:false,...categoryJob };
  categoryJob.running = true; categoryJob.started_at = new Date().toISOString(); categoryJob.last_error = null;
  try {
    const state = (await pool.query("SELECT * FROM market_category_sync_state WHERE id='takealot'")).rows[0];
    if (Number(state?.schema_version || 1) < CATEGORY_SYNC_SCHEMA) {
      await pool.query("DELETE FROM market_category_nodes");
      await pool.query("UPDATE market_category_sync_state SET status='pending',schema_version=$1,discovered_count=0,excluded_count=0,completed_at=NULL,last_error=NULL,started_at=NOW(),updated_at=NOW() WHERE id='takealot'", [CATEGORY_SYNC_SCHEMA]);
    }
    await pool.query("UPDATE market_category_sync_state SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id='takealot'");

    let pending = (await pool.query("SELECT * FROM market_category_nodes WHERE source='navigation' AND is_excluded=FALSE AND is_leaf=FALSE AND sync_status='pending' ORDER BY level,id LIMIT 1")).rows[0];
    if (!pending) {
      const rootCount = Number((await pool.query("SELECT COUNT(*)::int AS count FROM market_category_nodes WHERE level=1 AND source='navigation'")).rows[0]?.count || 0);
      if (rootCount === 0) {
        categoryJob.phase = "departments";
        const payload = await publicRequest("/cms/merchandised-departments?display_only=True");
        const departments = extractMerchandisedDepartments(payload);
        if (departments.length < 20 || !departments.some((node) => BOOK_NAMES.test(node.name))) throw new Error(`Navigation completeness check failed: ${departments.length} departments, Books missing`);
        await upsertCategoryNodes(pool, departments);
      }
    } else {
      categoryJob.phase = "navigation";
      let children = [];
      try {
        const payload = await publicRequest(`/cms/pages/${pending.source_path}?platform=desktop`);
        children = extractCmsCategoryNodes(payload, pending);
      } catch (error) {
        // Takealot navigation occasionally contains stale page links. A missing
        // page is a dead branch, not a failure of the complete tree sync.
        if (!isMissingNavigationPageError(error)) throw error;
      }
      await upsertCategoryNodes(pool, children);
      await pool.query("UPDATE market_category_nodes SET sync_status='complete',is_leaf=$2,updated_at=NOW() WHERE id=$1", [pending.id, children.length === 0]);
    }

    pending = (await pool.query("SELECT * FROM market_category_nodes WHERE source='navigation' AND is_excluded=FALSE AND is_leaf=FALSE AND sync_status='pending' ORDER BY level,id LIMIT 1")).rows[0];
    if (!pending) {
      const seedPaths = (await pool.query("SELECT category_path AS path FROM market_categories WHERE jsonb_array_length(category_path)>0")).rows;
      const knownNodes = seedPaths.flatMap(({ path }) => (Array.isArray(path) ? path : []).map((item,index,all) => ({ id:String(item.id),name:String(item.name),parent_id:index ? String(all[index-1].id) : null,level:index+1,path:all.slice(0,index+1).map((entry) => ({id:String(entry.id),name:String(entry.name)})),is_leaf:index===all.length-1,source:"product",source_path:null })));
      if (knownNodes.length) await upsertCategoryNodes(pool, knownNodes);
    }

    await pool.query(
      `UPDATE market_products p SET category_path=c.path,classification_status='mapped'
       FROM market_category_nodes c WHERE p.category_id=c.id AND p.classification_status<>'mapped'`,
    );
    const stats = (await pool.query(`SELECT COUNT(*)::int AS discovered,COUNT(*) FILTER (WHERE is_excluded)::int AS excluded,COUNT(*) FILTER (WHERE NOT is_excluded AND sync_status='pending')::int AS pending FROM market_category_nodes`)).rows[0];
    const remap = (await pool.query(`SELECT COUNT(*) FILTER (WHERE classification_status='mapped')::int AS mapped,COUNT(*) FILTER (WHERE classification_status<>'mapped')::int AS pending FROM market_products`)).rows[0];
    const integrity = (await pool.query(`SELECT COUNT(*) FILTER (WHERE level=1 AND source='navigation')::int AS roots,COUNT(*) FILTER (WHERE is_excluded AND level=1)::int AS excluded_roots,MAX(level)::int AS max_level FROM market_category_nodes`)).rows[0];
    const complete = Number(stats.pending) === 0 && Number(integrity.roots) >= 20 && Number(integrity.excluded_roots) >= 1 && Number(integrity.max_level) >= 2;
    if (Number(stats.pending) === 0 && !complete) throw new Error(`Category tree integrity failed: roots=${integrity.roots}, books=${integrity.excluded_roots}, levels=${integrity.max_level}`);
    await pool.query(`UPDATE market_category_sync_state SET status=$1,discovered_count=$2,excluded_count=$3,remapped_count=$4,pending_remap_count=$5,completed_at=CASE WHEN $1='complete' THEN NOW() ELSE completed_at END,last_error=NULL,updated_at=NOW() WHERE id='takealot'`, [complete ? "complete" : "running",stats.discovered,stats.excluded,remap.mapped,remap.pending]);
    return { accepted:true,complete,...stats,...integrity,remapped:remap.mapped,pending_remap:remap.pending };
  } catch (error) {
    categoryJob.last_error = error instanceof Error ? error.message : String(error);
    await pool.query("UPDATE market_category_sync_state SET status='failed',last_error=$1,updated_at=NOW() WHERE id='takealot'", [categoryJob.last_error]).catch(() => {});
    throw error;
  } finally { categoryJob.running = false; }
}

export async function categorySyncStatus(pool) {
  const state = (await pool.query("SELECT * FROM market_category_sync_state WHERE id='takealot'")).rows[0];
  return { ok:true,state,job:{...categoryJob} };
}

async function publicRequest(path) {
  const response = await fetch(`${PUBLIC_API_BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 Takealot-ERP-Market-Collector/2.0" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Takealot HTTP ${response.status}: ${text.slice(0, 180)}`);
  return JSON.parse(text);
}

function productRows(payload) {
  const results = payload?.sections?.products?.results;
  return Array.isArray(results) ? results.map((entry) => entry?.product_views || entry) : [];
}

function normalizeProduct(product, categoryId) {
  const core = product?.core || {};
  const gallery = product?.gallery || {};
  const buybox = product?.buybox_summary || product?.buybox || {};
  const stock = product?.stock_availability_summary || {};
  const prices = Array.isArray(buybox.prices) ? buybox.prices.map(Number).filter(Number.isFinite) : [];
  const id = String(core.id || "");
  const slug = String(core.slug || "");
  const images = Array.isArray(gallery.images) ? gallery.images : [];
  return {
    plid: id ? `PLID${id}` : null,
    tsin: buybox.tsin ? `TSIN${buybox.tsin}` : null,
    category_id: categoryId,
    title: core.title || null,
    subtitle: core.subtitle || null,
    brand: core.brand || null,
    image_url: images.length ? String(images[0]).replace("{size}", "fb") : null,
    product_url: id && slug ? `https://www.takealot.com/${slug}/PLID${id}` : null,
    price: prices.length ? Math.min(...prices) : null,
    listing_price: Number(buybox.listing_price) || null,
    rating: Number(core.star_rating) || null,
    reviews: Number(core.reviews) || 0,
    in_stock: Boolean(stock.is_in_stock),
    stock_status: stock.status || null,
  };
}

function namesFromPath(path) {
  return Array.isArray(path) ? path.map((node) => String(node?.name || "").trim()).filter(Boolean) : [];
}

export function validateBoundCategoryCollection({ reportedTotal, fetchedIds, detailLeafIds, expectedLeafId, sellerPathMatches }) {
  const ids = Array.isArray(fetchedIds) ? fetchedIds.map(String).filter(Boolean) : [];
  const uniqueIds = [...new Set(ids)];
  const detailIds = Array.isArray(detailLeafIds) ? detailLeafIds.map(String) : [];
  const detailMismatchCount = detailIds.filter((id) => id !== String(expectedLeafId)).length;
  const result = {
    reported_total: Number(reportedTotal || 0),
    fetched_count: ids.length,
    unique_count: uniqueIds.length,
    duplicate_count: ids.length - uniqueIds.length,
    detail_sample_count: detailIds.length,
    detail_mismatch_count: detailMismatchCount,
    seller_path_match_count: Number(sellerPathMatches || 0),
  };
  const problems = [];
  if (result.reported_total < 1) problems.push("Takealot returned an empty category");
  if (result.fetched_count !== result.reported_total) problems.push(`fetched ${result.fetched_count} of ${result.reported_total}`);
  if (result.unique_count !== result.reported_total) problems.push(`only ${result.unique_count} unique PLIDs`);
  if (result.duplicate_count !== 0) problems.push(`${result.duplicate_count} duplicate PLIDs`);
  if (result.detail_sample_count < 1) problems.push("no product details were sampled");
  if (result.detail_mismatch_count !== 0) problems.push(`${result.detail_mismatch_count} sampled products had another leaf category`);
  if (result.seller_path_match_count !== 1) problems.push(`seller path matched ${result.seller_path_match_count} records`);
  return { ok: problems.length === 0, problems, ...result };
}

async function resolveBoundSellerPath(pool) {
  const rows = (await pool.query(
    `SELECT canonical_category_id,full_path FROM market_category_paths
     WHERE source='seller_portal' AND is_current=TRUE AND is_excluded=FALSE AND leaf_name=$1`,
    [BOUND_CATEGORY_TEST.public_category_name],
  )).rows;
  const matches = rows.filter((row) => JSON.stringify(namesFromPath(row.full_path)) === JSON.stringify(BOUND_CATEGORY_TEST.seller_path_names));
  return { matches, seller: matches[0] || null };
}

async function fetchBoundCategoryProducts() {
  const rows = [];
  let after = "";
  let reportedTotal = 0;
  for (let page = 0; page < 50; page += 1) {
    const params = new URLSearchParams({ filter: `Category:${BOUND_CATEGORY_TEST.public_category_id}` });
    if (after) params.set("after", after);
    const listing = await publicRequest(`/searches/products?${params}`);
    const pageRows = productRows(listing);
    rows.push(...pageRows);
    const paging = listing?.sections?.products?.paging || {};
    reportedTotal = Number(paging.total_num_found || reportedTotal || rows.length);
    const next = String(paging.next_is_after || "");
    if (!next || next === after || pageRows.length === 0) break;
    after = next;
    if (page === 49) throw new Error("Category pagination exceeded the 50-page safety limit");
  }
  return { rows, reportedTotal };
}

async function sampleBoundCategoryDetails(items) {
  const leafIds = [];
  const sample = items.slice(0, BOUND_CATEGORY_TEST.detail_sample_size);
  for (let start = 0; start < sample.length; start += 5) {
    const batch = await Promise.all(sample.slice(start, start + 5).map(async (item) => {
      const detail = await publicRequest(`/product-details/${item.plid}?platform=desktop`);
      const breadcrumbs = Array.isArray(detail?.breadcrumbs?.items) ? detail.breadcrumbs.items : [];
      return String(breadcrumbs.at(-1)?.id || "");
    }));
    leafIds.push(...batch);
  }
  return leafIds;
}

async function runBoundCategoryCollectionTest(pool) {
  boundTestJob.running = true;
  boundTestJob.phase = "validating_seller_path";
  boundTestJob.started_at = new Date().toISOString();
  boundTestJob.last_error = null;
  try {
    const { matches, seller } = await resolveBoundSellerPath(pool);
    if (!seller || matches.length !== 1) throw new Error(`Expected one exact seller path, found ${matches.length}`);
    await pool.query(
      `INSERT INTO market_collection_tests
        (id,public_category_id,public_category_name,seller_category_id,seller_category_path,status,started_at,completed_at,last_error,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,'running',NOW(),NULL,NULL,NOW())
       ON CONFLICT (id) DO UPDATE SET public_category_id=excluded.public_category_id,
         public_category_name=excluded.public_category_name,seller_category_id=excluded.seller_category_id,
         seller_category_path=excluded.seller_category_path,status='running',started_at=NOW(),
         completed_at=NULL,last_error=NULL,updated_at=NOW()`,
      [BOUND_CATEGORY_TEST.id, BOUND_CATEGORY_TEST.public_category_id, BOUND_CATEGORY_TEST.public_category_name, seller.canonical_category_id, JSON.stringify(seller.full_path)],
    );
    await pool.query("DELETE FROM market_collection_test_products WHERE test_id=$1", [BOUND_CATEGORY_TEST.id]);

    boundTestJob.phase = "collecting";
    const { rows, reportedTotal } = await fetchBoundCategoryProducts();
    const items = rows.map((row) => normalizeProduct(row, BOUND_CATEGORY_TEST.public_category_id)).filter((item) => item.plid);
    boundTestJob.phase = "checking_details";
    const detailLeafIds = await sampleBoundCategoryDetails(items);
    const validation = validateBoundCategoryCollection({
      reportedTotal,
      fetchedIds: items.map((item) => item.plid),
      detailLeafIds,
      expectedLeafId: BOUND_CATEGORY_TEST.public_category_id,
      sellerPathMatches: matches.length,
    });
    if (!validation.ok) throw new Error(`Bound category validation failed: ${validation.problems.join(", ")}`);

    boundTestJob.phase = "saving_staging";
    const payload = items.map((item) => ({
      ...item,
      test_id: BOUND_CATEGORY_TEST.id,
      public_category_id: BOUND_CATEGORY_TEST.public_category_id,
      seller_category_id: seller.canonical_category_id,
      seller_category_path: seller.full_path,
    }));
    await pool.query(
      `INSERT INTO market_collection_test_products
        (test_id,plid,tsin,public_category_id,seller_category_id,seller_category_path,title,subtitle,brand,image_url,product_url,price,listing_price,rating,reviews,in_stock,stock_status,collected_at)
       SELECT x.test_id,x.plid,x.tsin,x.public_category_id,x.seller_category_id,x.seller_category_path,x.title,x.subtitle,x.brand,x.image_url,x.product_url,x.price,x.listing_price,x.rating,x.reviews,x.in_stock,x.stock_status,NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         test_id TEXT,plid TEXT,tsin TEXT,public_category_id TEXT,seller_category_id TEXT,seller_category_path JSONB,
         title TEXT,subtitle TEXT,brand TEXT,image_url TEXT,product_url TEXT,price NUMERIC,listing_price NUMERIC,
         rating NUMERIC,reviews INTEGER,in_stock BOOLEAN,stock_status TEXT)
       ON CONFLICT (test_id,plid) DO UPDATE SET title=excluded.title,subtitle=excluded.subtitle,
         brand=excluded.brand,image_url=excluded.image_url,product_url=excluded.product_url,
         price=excluded.price,listing_price=excluded.listing_price,rating=excluded.rating,
         reviews=excluded.reviews,in_stock=excluded.in_stock,stock_status=excluded.stock_status,
         seller_category_id=excluded.seller_category_id,seller_category_path=excluded.seller_category_path,collected_at=NOW()`,
      [JSON.stringify(payload)],
    );
    await pool.query(
      `UPDATE market_collection_tests SET status='complete',reported_total=$2,fetched_count=$3,
       unique_count=$4,duplicate_count=$5,detail_sample_count=$6,detail_mismatch_count=$7,
       completed_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1`,
      [BOUND_CATEGORY_TEST.id, validation.reported_total, validation.fetched_count, validation.unique_count,
       validation.duplicate_count, validation.detail_sample_count, validation.detail_mismatch_count],
    );
    boundTestJob.phase = "complete";
  } catch (error) {
    boundTestJob.last_error = error instanceof Error ? error.message : String(error);
    boundTestJob.phase = "failed";
    await pool.query(
      `INSERT INTO market_collection_tests (id,public_category_id,public_category_name,status,last_error,started_at,completed_at,updated_at)
       VALUES ($1,$2,$3,'failed',$4,NOW(),NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET status='failed',last_error=excluded.last_error,completed_at=NOW(),updated_at=NOW()`,
      [BOUND_CATEGORY_TEST.id, BOUND_CATEGORY_TEST.public_category_id, BOUND_CATEGORY_TEST.public_category_name, boundTestJob.last_error],
    ).catch(() => {});
  } finally {
    boundTestJob.running = false;
  }
}

export async function startBoundCategoryCollectionTest(pool) {
  if (!pool) throw new Error("Database not configured");
  if (boundTestJob.running) return { accepted: false, already_running: true, job: { ...boundTestJob } };
  void runBoundCategoryCollectionTest(pool);
  return { accepted: true, destructive: false, target: BOUND_CATEGORY_TEST, job: { ...boundTestJob, running: true } };
}

export async function boundCategoryCollectionTestStatus(pool) {
  const test = (await pool.query("SELECT * FROM market_collection_tests WHERE id=$1", [BOUND_CATEGORY_TEST.id])).rows[0] || null;
  const staged = Number((await pool.query("SELECT COUNT(*)::int AS count FROM market_collection_test_products WHERE test_id=$1", [BOUND_CATEGORY_TEST.id])).rows[0]?.count || 0);
  return { ok: true, destructive: false, target: BOUND_CATEGORY_TEST, test, staged_products: staged, job: { ...boundTestJob } };
}

async function resolveCategory(pool, category) {
  if (!category.id.startsWith("seed-")) return category;
  const detail = await publicRequest(`/product-details/${category.seed_plid}?platform=desktop`);
  const breadcrumbs = Array.isArray(detail?.breadcrumbs?.items) ? detail.breadcrumbs.items : [];
  const leaf = breadcrumbs.at(-1);
  if (!leaf?.id) throw new Error(`Cannot resolve category for ${category.seed_plid}`);
  const id = String(leaf.id);
  await pool.query(
    `INSERT INTO market_categories
       (id,name,name_zh,seed_plid,category_path,status,total_found,collected_count,updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,'pending',0,0,NOW())
     ON CONFLICT (id) DO UPDATE SET name=excluded.name,name_zh=excluded.name_zh,
       seed_plid=excluded.seed_plid,category_path=excluded.category_path,updated_at=NOW()`,
    [id, String(leaf.name || category.name), category.name_zh, category.seed_plid, JSON.stringify(breadcrumbs)],
  );
  await pool.query("DELETE FROM market_categories WHERE id=$1", [category.id]);
  return (await pool.query("SELECT * FROM market_categories WHERE id=$1", [id])).rows[0];
}

async function saveProducts(pool, items) {
  const snapshotDate = new Date().toISOString().slice(0, 10);
  for (const item of items) {
    if (!item.plid) continue;
    await pool.query(
      `INSERT INTO market_products
        (plid,tsin,category_id,title,subtitle,brand,image_url,product_url,price,listing_price,rating,reviews,in_stock,stock_status,first_seen_at,last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
       ON CONFLICT (plid) DO UPDATE SET tsin=excluded.tsin,category_id=excluded.category_id,
         title=excluded.title,subtitle=excluded.subtitle,brand=excluded.brand,image_url=excluded.image_url,
         product_url=excluded.product_url,price=excluded.price,listing_price=excluded.listing_price,
         rating=excluded.rating,reviews=excluded.reviews,in_stock=excluded.in_stock,
         stock_status=excluded.stock_status,last_seen_at=NOW()`,
      [item.plid,item.tsin,item.category_id,item.title,item.subtitle,item.brand,item.image_url,item.product_url,item.price,item.listing_price,item.rating,item.reviews,item.in_stock,item.stock_status],
    );
    await pool.query(
      `INSERT INTO market_product_snapshots
        (plid,snapshot_date,price,listing_price,rating,reviews,in_stock,stock_status,captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (plid,snapshot_date) DO UPDATE SET price=excluded.price,
         listing_price=excluded.listing_price,rating=excluded.rating,reviews=excluded.reviews,
         in_stock=excluded.in_stock,stock_status=excluded.stock_status,captured_at=NOW()`,
      [item.plid,snapshotDate,item.price,item.listing_price,item.rating,item.reviews,item.in_stock,item.stock_status],
    );
  }
}

export async function runMarketCollectionStep(pool) {
  if (!pool || jobs.running) return { accepted: false, ...jobs };
  jobs.running = true;
  jobs.started_at = new Date().toISOString();
  try {
    let category = (await pool.query(
      `SELECT * FROM market_categories
       WHERE status IN ('pending','collecting','failed')
          OR (status='complete' AND COALESCE(next_update_at,NOW()) <= NOW())
       ORDER BY CASE
                  WHEN COALESCE(name_zh,name) IN ('投影仪','假发') AND status IN ('pending','collecting','failed') THEN 0
                  WHEN status='pending' THEN 1 WHEN status='collecting' THEN 2 WHEN status='failed' THEN 3 ELSE 4
                END,
                updated_at ASC LIMIT 1`,
    )).rows[0];
    if (!category) return { accepted: false, idle: true, ...jobs };
    category = await resolveCategory(pool, category);
    jobs.category = category.name_zh || category.name;
    const refresh = category.status === "complete";
    const cursor = refresh ? "" : String(category.next_cursor || "");
    const params = new URLSearchParams({ filter: `Category:${category.id}` });
    if (cursor) params.set("after", cursor);
    const listing = await publicRequest(`/searches/products?${params}`);
    const rows = productRows(listing);
    const items = rows.map((row) => normalizeProduct(row, category.id));
    await saveProducts(pool, items);
    const paging = listing?.sections?.products?.paging || {};
    const next = String(paging.next_is_after || "");
    const total = Number(paging.total_num_found || category.total_found || items.length);
    const complete = !next || next === cursor || rows.length === 0;
    await pool.query(
      `UPDATE market_categories SET total_found=$1,next_cursor=$2,status=$3,
         collected_count=(SELECT COUNT(*) FROM market_products WHERE category_id=$4),
         last_collected_at=NOW(),completed_at=CASE WHEN $3='complete' THEN NOW() ELSE completed_at END,
         next_update_at=CASE WHEN $3='complete' THEN NOW()+INTERVAL '1 day' ELSE next_update_at END,
         last_error=NULL,updated_at=NOW() WHERE id=$4`,
      [total, complete ? null : next, complete ? "complete" : "collecting", category.id],
    );
    return { accepted: true, category: jobs.category, saved: items.length, complete, total };
  } catch (error) {
    jobs.last_error = error instanceof Error ? error.message : String(error);
    if (jobs.category) await pool.query("UPDATE market_categories SET status='failed',last_error=$1,updated_at=NOW() WHERE COALESCE(name_zh,name)=$2", [jobs.last_error, jobs.category]).catch(() => {});
    throw error;
  } finally {
    jobs.running = false;
  }
}

export function marketJobState() { return { ...jobs }; }

export async function marketLibrary(pool, query = {}) {
  const where = [];
  const values = [];
  const add = (sql, value) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
  if (query.category_id) {
    values.push(String(query.category_id));
    values.push(JSON.stringify([{ id:String(query.category_id) }]));
    where.push(`COALESCE(current_category_id,category_id) IN (SELECT id FROM market_category_nodes WHERE id=$${values.length - 1} OR path @> $${values.length}::jsonb)`);
  }
  if (query.q) { values.push(`%${query.q}%`); where.push(`(title ILIKE $${values.length} OR plid ILIKE $${values.length} OR tsin ILIKE $${values.length} OR brand ILIKE $${values.length})`); }
  if (query.stock === "in") where.push("in_stock=TRUE");
  if (query.stock === "out") where.push("in_stock=FALSE");
  for (const [key,column] of [["price_min","price"],["rating_min","rating"],["reviews_min","reviews"]]) if (query[key] !== undefined && query[key] !== "") add(`${column}>=?`, Number(query[key]));
  if (query.price_max !== undefined && query.price_max !== "") add("price<=?", Number(query.price_max));
  if (query.brand_mode === "branded") where.push("NULLIF(TRIM(brand),'') IS NOT NULL");
  if (query.brand_mode === "unbranded") where.push("NULLIF(TRIM(brand),'') IS NULL");
  if (query.brand) add("brand ILIKE ?", `%${query.brand}%`);
  if (query.freshness === "today") where.push("last_seen_at>=NOW()-INTERVAL '1 day'");
  if (query.freshness === "week") where.push("last_seen_at>=NOW()-INTERVAL '7 days'");
  const orders = { fresh:"last_seen_at DESC",rating:"rating DESC NULLS LAST,reviews DESC",reviews:"reviews DESC",price_low:"price ASC NULLS LAST",price_high:"price DESC NULLS LAST" };
  const limit = Math.min(Math.max(Number(query.limit || 200),1),500);
  const offset = Math.max(Number(query.offset || 0), 0);
  const filteredCountValues = values.slice();
  const filteredCount = (await pool.query(
    `SELECT COUNT(*)::int AS count FROM market_products p ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    filteredCountValues,
  )).rows[0]?.count || 0;
  values.push(limit);
  values.push(offset);
  const items = (await pool.query(
    `SELECT p.*,EXTRACT(DAY FROM last_seen_at-first_seen_at)::int+1 AS tracked_days,
       (SELECT COUNT(*) FROM market_product_snapshots s WHERE s.plid=p.plid) AS snapshot_count
     FROM market_products p ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${orders[query.sort] || orders.fresh} LIMIT $${values.length - 1} OFFSET $${values.length}`, values)).rows;
  const summary = (await pool.query("SELECT COUNT(*)::int AS count,COUNT(DISTINCT COALESCE(current_category_id,category_id))::int AS categories,COUNT(*) FILTER (WHERE in_stock)::int AS in_stock FROM market_products")).rows[0];
  const categories = (await pool.query(`SELECT n.id,n.name,n.name_zh,n.parent_id,n.level,n.path,n.is_leaf,n.source,n.is_current,n.version_id,
      COUNT(p.plid)::int AS collected_count,MAX(p.last_seen_at) AS last_collected_at
    FROM market_category_nodes n LEFT JOIN market_products p ON COALESCE(p.current_category_id,p.category_id)=n.id
    WHERE n.is_excluded=FALSE GROUP BY n.id ORDER BY n.level,n.name`)).rows;
  const snapshots = (await pool.query("SELECT COUNT(*)::int AS count FROM market_product_snapshots")).rows[0]?.count || 0;
  return { ok:true,items,filtered_count:filteredCount,summary:{...summary,snapshots},categories,generated_at:new Date().toISOString() };
}

export async function marketProduct(pool, plid) {
  const product = (await pool.query(`SELECT p.*,EXTRACT(DAY FROM last_seen_at-first_seen_at)::int+1 AS tracked_days FROM market_products p WHERE plid=$1`, [plid])).rows[0];
  const snapshots = (await pool.query("SELECT plid||':'||snapshot_date AS id,* FROM market_product_snapshots WHERE plid=$1 ORDER BY snapshot_date ASC LIMIT 365", [plid])).rows;
  return { ok:true,product,snapshots,generated_at:new Date().toISOString() };
}
