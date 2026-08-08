const PUBLIC_API_BASE = "https://api.takealot.com/rest/v-1-18-0";

const jobs = { running: false, category: null, started_at: null, last_error: null };

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
       ORDER BY CASE status WHEN 'collecting' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
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
  if (query.category_id) add("category_id=?", String(query.category_id));
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
  values.push(limit);
  const items = (await pool.query(
    `SELECT p.*,EXTRACT(DAY FROM last_seen_at-first_seen_at)::int+1 AS tracked_days,
       (SELECT COUNT(*) FROM market_product_snapshots s WHERE s.plid=p.plid) AS snapshot_count
     FROM market_products p ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${orders[query.sort] || orders.fresh} LIMIT $${values.length}`, values)).rows;
  const summary = (await pool.query("SELECT COUNT(*)::int AS count,COUNT(DISTINCT category_id)::int AS categories,COUNT(*) FILTER (WHERE in_stock)::int AS in_stock FROM market_products")).rows[0];
  const categories = (await pool.query("SELECT id,name,name_zh,path,total_found,collected_count,last_collected_at,completed_at FROM (SELECT id,name,name_zh,category_path AS path,total_found,collected_count,last_collected_at,completed_at,status FROM market_categories) c WHERE status='complete' ORDER BY completed_at DESC")).rows;
  const snapshots = (await pool.query("SELECT COUNT(*)::int AS count FROM market_product_snapshots")).rows[0]?.count || 0;
  return { ok:true,items,summary:{...summary,snapshots},categories,generated_at:new Date().toISOString() };
}

export async function marketProduct(pool, plid) {
  const product = (await pool.query(`SELECT p.*,EXTRACT(DAY FROM last_seen_at-first_seen_at)::int+1 AS tracked_days FROM market_products p WHERE plid=$1`, [plid])).rows[0];
  const snapshots = (await pool.query("SELECT plid||':'||snapshot_date AS id,* FROM market_product_snapshots WHERE plid=$1 ORDER BY snapshot_date ASC LIMIT 365", [plid])).rows;
  return { ok:true,product,snapshots,generated_at:new Date().toISOString() };
}
