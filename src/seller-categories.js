const BOOK_NAMES = /^(books?|books?\s*&\s*courses?|books?\s*&\s*media|boeke|图书)$/i;
const SOURCE = "seller_portal";

const categoryJob = { running: false, phase: "awaiting_source", started_at: null, last_error: null };

function text(value) {
  return value == null ? "" : String(value).trim();
}

function rawChildren(value) {
  if (!value || typeof value !== "object") return [];
  for (const key of ["children", "categories", "subCategories", "sub_categories", "departments", "items", "options", "values"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function categoryIdentity(value) {
  if (!value || typeof value !== "object") return { id: "", name: "" };
  const id = text(value.id ?? value.categoryId ?? value.category_id ?? value.value ?? value.code ?? value.uuid);
  const name = text(value.name ?? value.displayName ?? value.display_name ?? value.label ?? value.title);
  return { id, name };
}

function candidateRoots(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["departments", "categories", "categoryTree", "category_tree", "data", "items", "options", "values"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = candidateRoots(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

export function extractSellerCategoryNodes(payload) {
  const roots = candidateRoots(payload);
  const nodes = [];
  const seen = new Set();

  const visit = (value, parent = null, parentPath = []) => {
    if (!value || typeof value !== "object") return;
    const { id, name } = categoryIdentity(value);
    const children = rawChildren(value);
    if (!id || !name) {
      children.forEach((child) => visit(child, parent, parentPath));
      return;
    }
    const path = [...parentPath, { id, name }];
    const key = `${id}:${parent?.id || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      nodes.push({
        id,
        name,
        parent_id: parent?.id || null,
        level: path.length,
        path,
        is_leaf: children.length === 0 || value.selectable === true || value.isLeaf === true || value.is_leaf === true,
        is_excluded: path.some((entry) => BOOK_NAMES.test(entry.name)),
        source: SOURCE,
      });
    }
    children.forEach((child) => visit(child, { id, name }, path));
  };

  roots.forEach((root) => visit(root));
  return nodes;
}

export function validateSellerCategoryTree(nodes) {
  const included = nodes.filter((node) => !node.is_excluded);
  const roots = nodes.filter((node) => node.level === 1);
  const usableRoots = included.filter((node) => node.level === 1);
  const leaves = included.filter((node) => node.is_leaf);
  const maxLevel = included.reduce((max, node) => Math.max(max, node.level), 0);
  const excludedBooks = nodes.filter((node) => node.is_excluded).length;
  const duplicateIds = nodes.length - new Set(nodes.map((node) => node.id)).size;
  const problems = [];
  if (roots.length < 5) problems.push(`only ${roots.length} department roots`);
  if (usableRoots.length < 4) problems.push(`only ${usableRoots.length} usable department roots`);
  if (maxLevel < 3) problems.push(`only ${maxLevel} levels`);
  if (leaves.length < 10) problems.push(`only ${leaves.length} selectable categories`);
  if (duplicateIds > 0) problems.push(`${duplicateIds} duplicate category ids`);
  return {
    valid: problems.length === 0,
    problems,
    counts: {
      total: nodes.length,
      usable: included.length,
      excluded_books: excludedBooks,
      selectable: leaves.length,
      max_level: maxLevel,
      by_level: Object.fromEntries([1, 2, 3, 4, 5, 6].map((level) => [level, included.filter((node) => node.level === level).length])),
    },
  };
}

export async function importSellerCategoryTree(pool, payload, sourceRef = "seller-portal-http") {
  if (!pool) throw new Error("Database not configured");
  const nodes = extractSellerCategoryNodes(payload);
  const validation = validateSellerCategoryTree(nodes);
  if (!validation.valid) throw new Error(`Seller category tree rejected: ${validation.problems.join(", ")}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const version = (await client.query(
      `INSERT INTO market_category_versions (source,source_ref,status,node_count,excluded_count,max_level,level_counts,validated_at)
       VALUES ($1,$2,'active',$3,$4,$5,$6::jsonb,NOW()) RETURNING id`,
      [SOURCE, sourceRef, validation.counts.total, validation.counts.excluded_books, validation.counts.max_level, JSON.stringify(validation.counts.by_level)],
    )).rows[0];

    await client.query("UPDATE market_category_versions SET status='superseded' WHERE source=$1 AND status='active' AND id<>$2", [SOURCE, version.id]);
    await client.query("UPDATE market_category_nodes SET is_current=FALSE WHERE source=$1", [SOURCE]);

    for (const node of nodes) {
      await client.query(
        `INSERT INTO market_category_nodes
          (id,name,parent_id,level,path,is_leaf,is_excluded,sync_status,source,source_path,version_id,is_current,updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'complete',$8,$9,$10,TRUE,NOW())
         ON CONFLICT (id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,level=excluded.level,
           path=excluded.path,is_leaf=excluded.is_leaf,is_excluded=excluded.is_excluded,sync_status='complete',
           source=excluded.source,source_path=excluded.source_path,version_id=excluded.version_id,is_current=TRUE,updated_at=NOW()`,
        [node.id, node.name, node.parent_id, node.level, JSON.stringify(node.path), node.is_leaf, node.is_excluded, SOURCE, sourceRef, version.id],
      );
    }

    // Front-store navigation rows are never a standard category source. They
    // are removed only after a complete seller tree has passed validation.
    await client.query("DELETE FROM market_category_nodes WHERE source='navigation'");
    await client.query(
      `UPDATE market_category_sync_state SET status='complete',source=$1,phase='catalog_ready',
       discovered_count=$2,excluded_count=$3,max_level=$4,level_counts=$5::jsonb,
       active_version_id=$6,completed_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id='takealot'`,
      [SOURCE, validation.counts.total, validation.counts.excluded_books, validation.counts.max_level, JSON.stringify(validation.counts.by_level), version.id],
    );
    await client.query("COMMIT");
    categoryJob.phase = "catalog_ready";
    return { ok: true, source: SOURCE, version_id: version.id, ...validation.counts };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function sellerHeaders(config) {
  return {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 Takealot-ERP-Category-Sync/1.0",
    ...(config.sellerCategoryCookie ? { Cookie: config.sellerCategoryCookie } : {}),
    ...(config.sellerCategoryCsrfToken ? { "X-CSRF-Token": config.sellerCategoryCsrfToken } : {}),
  };
}

export async function runSellerCategorySync(pool, config) {
  if (!pool || categoryJob.running) return { accepted: false, ...categoryJob };
  if (!config?.sellerCategoryUrl || !config?.sellerCategoryCookie) {
    categoryJob.phase = "awaiting_session";
    return { accepted: false, phase: categoryJob.phase, reason: "seller_portal_session_not_configured" };
  }
  categoryJob.running = true;
  categoryJob.phase = "downloading_catalog";
  categoryJob.started_at = new Date().toISOString();
  categoryJob.last_error = null;
  try {
    const state = (await pool.query("SELECT status,source,updated_at FROM market_category_sync_state WHERE id='takealot'")).rows[0];
    if (state?.status === "complete" && state?.source === SOURCE && Date.now() - new Date(state.updated_at).getTime() < 24 * 60 * 60_000) {
      categoryJob.phase = "catalog_ready";
      return { accepted: false, complete: true, phase: categoryJob.phase, reason: "catalog_is_current" };
    }
    await pool.query("UPDATE market_category_sync_state SET status='running',source=$1,phase=$2,started_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id='takealot'", [SOURCE, categoryJob.phase]);
    const response = await fetch(config.sellerCategoryUrl, { headers: sellerHeaders(config) });
    const body = await response.text();
    if (response.status === 401 || response.status === 403) throw new Error("Seller portal session expired; login verification is required");
    if (!response.ok) throw new Error(`Seller portal category request failed (${response.status})`);
    const payload = JSON.parse(body);
    categoryJob.phase = "validating_catalog";
    return await importSellerCategoryTree(pool, payload, config.sellerCategoryUrl);
  } catch (error) {
    categoryJob.last_error = error instanceof Error ? error.message : String(error);
    categoryJob.phase = /session expired/i.test(categoryJob.last_error) ? "awaiting_session" : "failed";
    await pool.query("UPDATE market_category_sync_state SET status=$1,phase=$2,last_error=$3,updated_at=NOW() WHERE id='takealot'", [categoryJob.phase === "awaiting_session" ? "awaiting_session" : "failed", categoryJob.phase, categoryJob.last_error]).catch(() => {});
    throw error;
  } finally {
    categoryJob.running = false;
  }
}

export async function sellerCategoryStatus(pool) {
  const state = (await pool.query("SELECT * FROM market_category_sync_state WHERE id='takealot'")).rows[0];
  const levels = (await pool.query(
    `SELECT level,COUNT(*)::int AS count FROM market_category_nodes
     WHERE source=$1 AND is_current=TRUE AND is_excluded=FALSE GROUP BY level ORDER BY level`,
    [SOURCE],
  )).rows;
  return {
    ok: true,
    product_collection: "paused",
    product_matching: state?.status === "complete" ? "ready_not_started" : "blocked_until_catalog_ready",
    state,
    levels,
    job: { ...categoryJob },
  };
}

export function categoryImportAuthorized(req, config) {
  if (!config?.categoryAdminToken) return false;
  return req.get("Authorization") === `Bearer ${config.categoryAdminToken}`;
}
