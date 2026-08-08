import { createHash } from "node:crypto";
import fs from "node:fs/promises";

const BOOK_NAMES = /^(books?|books?\s*&\s*courses?|books?\s*&\s*media|boeke|图书)$/i;
const SOURCE = "seller_portal";

const categoryJob = { running: false, phase: "awaiting_source", started_at: null, last_error: null };

function text(value) {
  return value == null ? "" : String(value).trim();
}

function stableId(prefix, names) {
  return `${prefix}-${createHash("sha1").update(names.join("\u001f")).digest("hex").slice(0, 20)}`;
}

function nodePath(names) {
  return names.map((name, index) => ({ id: stableId("seller-category", names.slice(0, index + 1)), name }));
}

function extractManualCatalog(payload) {
  if (payload?.schema !== "takealot-manual-catalog-v1" || !Array.isArray(payload.departments)) return null;
  const nodes = new Map();
  const paths = [];
  const putNode = (names, metadata = {}) => {
    const path = nodePath(names);
    const node = {
      id: path.at(-1).id,
      name: names.at(-1),
      parent_id: path.length > 1 ? path.at(-2).id : null,
      level: path.length,
      path,
      is_leaf: path.length === 3,
      is_excluded: names.some((name) => BOOK_NAMES.test(name)),
      requires_qualification: Boolean(metadata.requires_qualification),
      is_special: Boolean(metadata.is_special),
      source: SOURCE,
    };
    const existing = nodes.get(node.id);
    nodes.set(node.id, existing ? {
      ...existing,
      requires_qualification: existing.requires_qualification || node.requires_qualification,
      is_special: existing.is_special || node.is_special,
    } : node);
    return node;
  };

  for (const department of payload.departments) {
    const departmentName = text(department?.name);
    if (!departmentName) continue;
    putNode([departmentName]);
    for (const subdepartment of Array.isArray(department?.subdepartments) ? department.subdepartments : []) {
      const subdepartmentName = text(subdepartment?.name);
      if (!subdepartmentName) continue;
      putNode([departmentName, subdepartmentName], { requires_qualification: subdepartment.requires_qualification });
      for (const entry of Array.isArray(subdepartment?.paths) ? subdepartment.paths : []) {
        const segments = Array.isArray(entry?.segments) ? entry.segments.map(text).filter(Boolean) : [];
        if (!segments.length) continue;
        const canonicalNames = [departmentName, subdepartmentName, segments[0]];
        const canonical = putNode(canonicalNames);
        const fullNames = [departmentName, subdepartmentName, ...segments];
        const excluded = fullNames.some((name) => BOOK_NAMES.test(name));
        paths.push({
          path_id: stableId("seller-path", fullNames),
          canonical_category_id: canonical.id,
          full_path: nodePath(fullNames),
          leaf_name: fullNames.at(-1),
          depth: fullNames.length,
          requires_qualification: Boolean(entry.requires_qualification),
          is_special: Boolean(entry.is_special),
          is_excluded: excluded,
        });
      }
    }
  }
  return { nodes: [...nodes.values()], paths };
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
  const manual = extractManualCatalog(payload);
  if (manual) return manual.nodes;
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

export function extractSellerCategoryPaths(payload) {
  return extractManualCatalog(payload)?.paths ?? [];
}

export function validateSellerCategoryTree(nodes, paths = []) {
  const included = nodes.filter((node) => !node.is_excluded);
  const roots = nodes.filter((node) => node.level === 1);
  const usableRoots = included.filter((node) => node.level === 1);
  const leaves = included.filter((node) => node.is_leaf);
  const maxLevel = included.reduce((max, node) => Math.max(max, node.level), 0);
  const excludedBooks = nodes.filter((node) => node.is_excluded).length;
  const duplicateIds = nodes.length - new Set(nodes.map((node) => node.id)).size;
  const usablePaths = paths.filter((path) => !path.is_excluded);
  const qualificationCount = paths.filter((path) => path.requires_qualification).length
    + nodes.filter((node) => node.level === 2 && node.requires_qualification).length;
  const specialCount = paths.filter((path) => path.is_special).length;
  const rawMaxLevel = paths.reduce((max, path) => Math.max(max, path.depth), maxLevel);
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
      full_paths: paths.length,
      usable_paths: usablePaths.length,
      qualification_count: qualificationCount,
      special_count: specialCount,
      raw_max_level: rawMaxLevel,
    },
  };
}

export async function importSellerCategoryTree(pool, payload, sourceRef = "seller-portal-http") {
  if (!pool) throw new Error("Database not configured");
  const nodes = extractSellerCategoryNodes(payload);
  const paths = extractSellerCategoryPaths(payload);
  const validation = validateSellerCategoryTree(nodes, paths);
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
    await client.query("UPDATE market_category_paths SET is_current=FALSE WHERE source=$1", [SOURCE]);

    for (const node of nodes) {
      await client.query(
        `INSERT INTO market_category_nodes
          (id,name,parent_id,level,path,is_leaf,is_excluded,sync_status,source,source_path,version_id,is_current,requires_qualification,is_special,updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'complete',$8,$9,$10,TRUE,$11,$12,NOW())
         ON CONFLICT (id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,level=excluded.level,
           path=excluded.path,is_leaf=excluded.is_leaf,is_excluded=excluded.is_excluded,sync_status='complete',
           source=excluded.source,source_path=excluded.source_path,version_id=excluded.version_id,is_current=TRUE,
           requires_qualification=excluded.requires_qualification,is_special=excluded.is_special,updated_at=NOW()`,
        [node.id, node.name, node.parent_id, node.level, JSON.stringify(node.path), node.is_leaf, node.is_excluded, SOURCE, sourceRef, version.id, Boolean(node.requires_qualification), Boolean(node.is_special)],
      );
    }

    if (paths.length) {
      const pathRows = paths.map((path) => ({ ...path, full_path: path.full_path, source: SOURCE, source_ref: sourceRef, version_id: Number(version.id) }));
      await client.query(
        `INSERT INTO market_category_paths
          (path_id,canonical_category_id,full_path,leaf_name,depth,requires_qualification,is_special,is_excluded,source,source_ref,version_id,is_current,updated_at)
         SELECT x.path_id,x.canonical_category_id,x.full_path,x.leaf_name,x.depth,x.requires_qualification,x.is_special,x.is_excluded,x.source,x.source_ref,x.version_id,TRUE,NOW()
         FROM jsonb_to_recordset($1::jsonb) AS x(
           path_id TEXT,canonical_category_id TEXT,full_path JSONB,leaf_name TEXT,depth INTEGER,
           requires_qualification BOOLEAN,is_special BOOLEAN,is_excluded BOOLEAN,source TEXT,source_ref TEXT,version_id BIGINT)
         ON CONFLICT (path_id) DO UPDATE SET canonical_category_id=excluded.canonical_category_id,
           full_path=excluded.full_path,leaf_name=excluded.leaf_name,depth=excluded.depth,
           requires_qualification=excluded.requires_qualification,is_special=excluded.is_special,
           is_excluded=excluded.is_excluded,source=excluded.source,source_ref=excluded.source_ref,
           version_id=excluded.version_id,is_current=TRUE,updated_at=NOW()`,
        [JSON.stringify(pathRows)],
      );
    }

    // Front-store navigation rows are never a standard category source. They
    // are removed only after a complete seller tree has passed validation.
    await client.query("DELETE FROM market_category_nodes WHERE source='navigation'");
    await client.query(
      `UPDATE market_category_sync_state SET status='complete',source=$1,phase='catalog_ready',
       discovered_count=$2,excluded_count=$3,max_level=$4,level_counts=$5::jsonb,
       active_version_id=$6,full_path_count=$7,usable_path_count=$8,qualification_count=$9,
       special_count=$10,raw_max_level=$11,completed_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id='takealot'`,
      [SOURCE, validation.counts.total, validation.counts.excluded_books, validation.counts.max_level, JSON.stringify(validation.counts.by_level), version.id,
       validation.counts.full_paths, validation.counts.usable_paths, validation.counts.qualification_count,
       validation.counts.special_count, validation.counts.raw_max_level],
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

export async function bootstrapBundledCategoryCatalog(pool, filePath) {
  if (!pool || !filePath) return { imported: false, reason: "not_configured" };
  const sourceRef = "complete-categories.xlsx:2026-08-08";
  const active = (await pool.query(
    "SELECT id FROM market_category_versions WHERE source=$1 AND source_ref=$2 AND status='active' ORDER BY id DESC LIMIT 1",
    [SOURCE, sourceRef],
  )).rows[0];
  if (active) return { imported: false, reason: "already_current", version_id: active.id };
  const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
  return { imported: true, ...(await importSellerCategoryTree(pool, payload, sourceRef)) };
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
