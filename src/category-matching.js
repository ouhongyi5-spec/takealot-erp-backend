const STOPWORDS = new Set([
  "a","an","and","for","from","in","of","on","or","the","to","with","new","set","pack","piece","pieces",
  "product","products","accessory","accessories","other","general","universal","assorted","various",
]);

const matchJob = { running: false, status: "ready_not_started", processed: 0, total: 0, started_at: null, last_error: null };

function text(value) { return value == null ? "" : String(value).trim(); }
function normalizeToken(value) {
  const token = text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}
function tokens(value) {
  return [...new Set(text(value).toLowerCase().split(/[^a-z0-9]+/g).map(normalizeToken).filter((token) => token.length > 1 && !STOPWORDS.has(token)))];
}
function pathNames(path) { return Array.isArray(path) ? path.map((node) => text(node?.name)).filter(Boolean) : []; }
function overlap(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}
function ratio(left, right) { return left.length ? overlap(left, right).length / left.length : 0; }
function band(confidence) { return confidence >= 95 ? "high" : confidence >= 80 ? "review" : "calibration"; }

function ruleApplies(rule, product, productTokens) {
  if (rule.legacy_category_id && text(rule.legacy_category_id) !== text(product.original_category_id)) return false;
  const conditions = Array.isArray(rule.keyword_conditions) ? rule.keyword_conditions.map(normalizeToken).filter(Boolean) : [];
  if (conditions.length && !conditions.every((condition) => productTokens.includes(condition))) return false;
  const attributes = rule.attribute_conditions && typeof rule.attribute_conditions === "object" ? rule.attribute_conditions : {};
  if (attributes.brand && normalizeToken(attributes.brand) !== normalizeToken(product.brand)) return false;
  return Boolean(rule.legacy_category_id || conditions.length || attributes.brand);
}

function scoreCandidate(product, candidate) {
  const title = text(`${product.title || ""} ${product.subtitle || ""} ${product.brand || ""}`);
  const titleTokens = tokens(title);
  const originalNames = pathNames(product.original_category_path);
  const originalTokens = tokens(originalNames.join(" "));
  const originalLeaf = normalizeToken(originalNames.at(-1));
  const candidateNames = pathNames(candidate.path);
  const candidatePathTokens = candidate._pathTokens || tokens(candidateNames.join(" "));
  const leafName = candidate._leafName || candidateNames.at(-1) || candidate.name;
  const leafTokens = candidate._leafTokens || tokens(leafName);
  const deepTokens = candidate._deepTokens || tokens((candidate.deep_leaf_names || []).join(" "));
  const evidence = [];
  let ruleKeywords = [];
  let score = 0;

  if (originalLeaf && originalLeaf === normalizeToken(leafName)) { score = 98; evidence.push("原末级类目名称一致"); }
  else {
    const titleLeaf = overlap(leafTokens, titleTokens);
    const legacyPath = overlap(originalTokens, candidatePathTokens);
    const titlePath = overlap(candidatePathTokens, titleTokens);
    const titleDeep = overlap(titleTokens, deepTokens);
    score += ratio(leafTokens, titleTokens) * 42;
    score += ratio(originalTokens, candidatePathTokens) * 28;
    score += Math.min(1, titlePath.length / 3) * 14;
    score += Math.min(1, titleDeep.length / 3) * 10;
    if (leafName.length >= 5 && title.toLowerCase().includes(leafName.toLowerCase())) score += 12;
    if (titleLeaf.length) evidence.push(`标题命中：${titleLeaf.slice(0, 4).join("、")}`);
    if (legacyPath.length) evidence.push(`原类目命中：${legacyPath.slice(0, 4).join("、")}`);
    if (titleDeep.length) evidence.push(`深层路径命中：${titleDeep.slice(0, 4).join("、")}`);
    ruleKeywords = [...new Set([...titleLeaf, ...titleDeep])].slice(0, 5);
  }
  return { score: Math.min(98, Math.round(score)), evidence, ruleKeywords };
}

async function loadCandidates(pool) {
  const rows = (await pool.query(
    `SELECT n.id,n.name,n.path,
       COALESCE(array_agg(DISTINCT p.leaf_name) FILTER (WHERE p.leaf_name IS NOT NULL),'{}') AS deep_leaf_names
     FROM market_category_nodes n
     LEFT JOIN market_category_paths p ON p.canonical_category_id=n.id AND p.is_current=TRUE AND p.is_excluded=FALSE
     WHERE n.source='seller_portal' AND n.is_current=TRUE AND n.is_excluded=FALSE AND n.level=3
     GROUP BY n.id,n.name,n.path ORDER BY n.name`,
  )).rows;
  return rows.map((candidate) => {
    const names = pathNames(candidate.path);
    const leafName = names.at(-1) || candidate.name;
    return { ...candidate, _pathTokens: tokens(names.join(" ")), _leafName: leafName, _leafTokens: tokens(leafName), _deepTokens: tokens((candidate.deep_leaf_names || []).join(" ")) };
  });
}

function recommend(product, candidates, rulesByCategory) {
  const productTokens = tokens(`${product.title || ""} ${product.subtitle || ""} ${product.brand || ""}`);
  for (const rule of rulesByCategory) {
    if (!ruleApplies(rule, product, productTokens)) continue;
    const current = candidates.find((candidate) => candidate.id === rule.current_category_id);
    if (current) return { category: current, confidence: 100, method: "saved_rule", evidence: ["已确认永久规则"], alternatives: [] };
  }
  const ranked = candidates.map((candidate) => ({ candidate, ...scoreCandidate(product, candidate) }))
    .sort((left, right) => right.score - left.score || left.candidate.name.localeCompare(right.candidate.name));
  const best = ranked[0];
  if (!best || best.score < 35) return null;
  const second = ranked[1]?.score || 0;
  const gap = Math.max(0, best.score - second);
  const separation = Math.min(6, gap);
  let confidence = Math.min(98, best.score + separation);
  const ambiguous = ranked.length > 1 && gap <= 2;
  if (ambiguous) confidence = Math.min(confidence, 79);
  const evidence = ambiguous
    ? [...best.evidence, "存在同分或近似同分候选，需人工确认"]
    : best.evidence;
  return {
    category: best.candidate,
    confidence,
    method: "keyword_path_v1",
    evidence,
    ruleKeywords: best.ruleKeywords,
    alternatives: ranked.slice(1, 3).map((entry) => ({ id: entry.candidate.id, name: entry.candidate.name, path: entry.candidate.path, confidence: entry.score, evidence: entry.evidence, keywords: entry.ruleKeywords })),
  };
}

export function recommendCategoryForProduct(product, candidates, rules = []) {
  return recommend(product, candidates, rules);
}

async function refreshMatchState(pool, status = null, lastError = null) {
  const counts = (await pool.query(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE category_match_status<>'pending')::int AS processed,
       COUNT(*) FILTER (WHERE category_match_status='recommended')::int AS recommended,
       COUNT(*) FILTER (WHERE category_match_status='confirmed')::int AS confirmed,
       COUNT(*) FILTER (WHERE category_match_status='unmatched')::int AS unmatched,
       COUNT(*) FILTER (WHERE category_match_status='recommended' AND category_match_confidence>=95)::int AS high,
       COUNT(*) FILTER (WHERE category_match_status='recommended' AND category_match_confidence>=80 AND category_match_confidence<95)::int AS review,
       COUNT(*) FILTER (WHERE category_match_status='recommended' AND category_match_confidence<80)::int AS calibration
     FROM market_products`,
  )).rows[0];
  const nextStatus = status || (Number(counts.processed) >= Number(counts.total) ? "review_ready" : Number(counts.processed) ? "paused" : "ready_not_started");
  await pool.query(
    `INSERT INTO market_category_match_state
      (id,status,total_products,processed_count,recommended_count,high_count,review_count,calibration_count,confirmed_count,unmatched_count,last_error,updated_at,completed_at)
     VALUES ('takealot',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),CASE WHEN $1='review_ready' THEN NOW() ELSE NULL END)
     ON CONFLICT (id) DO UPDATE SET status=excluded.status,total_products=excluded.total_products,
       processed_count=excluded.processed_count,recommended_count=excluded.recommended_count,high_count=excluded.high_count,
       review_count=excluded.review_count,calibration_count=excluded.calibration_count,confirmed_count=excluded.confirmed_count,
       unmatched_count=excluded.unmatched_count,last_error=excluded.last_error,updated_at=NOW(),
       completed_at=CASE WHEN excluded.status='review_ready' THEN NOW() ELSE market_category_match_state.completed_at END`,
    [nextStatus,counts.total,counts.processed,counts.recommended,counts.high,counts.review,counts.calibration,counts.confirmed,counts.unmatched,lastError],
  );
  await pool.query(
    `UPDATE market_category_sync_state SET remapped_count=$1,pending_remap_count=$2,updated_at=NOW() WHERE id='takealot'`,
    [counts.confirmed, Number(counts.total) - Number(counts.confirmed)],
  );
  return { ...counts, status: nextStatus };
}

async function runMatching(pool) {
  matchJob.running = true; matchJob.status = "running"; matchJob.processed = 0; matchJob.started_at = new Date().toISOString(); matchJob.last_error = null;
  try {
    const candidates = await loadCandidates(pool);
    if (!candidates.length) throw new Error("No current seller-portal level-3 categories are available");
    const rules = (await pool.query("SELECT * FROM market_category_mapping_rules WHERE enabled=TRUE ORDER BY decision_source='manual' DESC,id DESC")).rows;
    matchJob.total = Number((await pool.query("SELECT COUNT(*)::int AS count FROM market_products WHERE category_match_status='pending'")).rows[0]?.count || 0);
    await refreshMatchState(pool, "running");
    while (true) {
      const products = (await pool.query(
        `SELECT plid,title,subtitle,brand,original_category_id,original_category_path
         FROM market_products WHERE category_match_status='pending' ORDER BY plid LIMIT 200`,
      )).rows;
      if (!products.length) break;
      for (const product of products) {
        const result = recommend(product, candidates, rules);
        if (!result) {
          await pool.query("UPDATE market_products SET category_match_status='unmatched',category_match_method='keyword_path_v1',category_matched_at=NOW() WHERE plid=$1", [product.plid]);
        } else {
          const allCandidates = [{ id: result.category.id, name: result.category.name, path: result.category.path, confidence: result.confidence, evidence: result.evidence, keywords: result.ruleKeywords || [] }, ...result.alternatives];
          await pool.query(
            `UPDATE market_products SET recommended_category_id=$2,recommended_category_path=$3::jsonb,recommended_candidates=$4::jsonb,
             category_match_confidence=$5,category_match_method=$6,category_match_status='recommended',category_match_evidence=$7::jsonb,category_matched_at=NOW()
             WHERE plid=$1`,
            [product.plid,result.category.id,JSON.stringify(result.category.path),JSON.stringify(allCandidates),result.confidence,result.method,JSON.stringify(result.evidence)],
          );
        }
        matchJob.processed += 1;
      }
      await refreshMatchState(pool, "running");
    }
    matchJob.status = "review_ready";
    await refreshMatchState(pool, "review_ready");
  } catch (error) {
    matchJob.last_error = error instanceof Error ? error.message : String(error);
    matchJob.status = "failed";
    await refreshMatchState(pool, "failed", matchJob.last_error).catch(() => {});
  } finally { matchJob.running = false; }
}

async function resetUnconfirmedRecommendations(pool) {
  await pool.query(
    `UPDATE market_products SET recommended_category_id=NULL,recommended_category_path='[]'::jsonb,
       recommended_candidates='[]'::jsonb,category_match_confidence=NULL,category_match_method=NULL,
       category_match_evidence='[]'::jsonb,category_match_status='pending',category_matched_at=NULL
     WHERE current_category_id IS NULL`,
  );
  matchJob.status = "ready_not_started";
  matchJob.processed = 0;
  matchJob.total = 0;
  matchJob.started_at = null;
  matchJob.last_error = null;
  await refreshMatchState(pool, "ready_not_started");
}

export async function startCategoryMatching(pool, options = {}) {
  if (!pool) throw new Error("Database not configured");
  if (matchJob.running) return { accepted: false, job: { ...matchJob } };
  const catalog = (await pool.query("SELECT status,source,active_version_id FROM market_category_sync_state WHERE id='takealot'")).rows[0];
  if (catalog?.status !== "complete" || catalog?.source !== "seller_portal") throw new Error("Current seller-portal category catalog is not ready");
  if (options.resetUnconfirmed === true) await resetUnconfirmedRecommendations(pool);
  void runMatching(pool);
  return { accepted: true, reset_unconfirmed: options.resetUnconfirmed === true, job: { ...matchJob } };
}

export async function categoryMatchingStatus(pool) {
  const state = await refreshMatchState(pool, matchJob.running ? "running" : null);
  return { ok: true, state, job: { ...matchJob }, thresholds: { high: 95, review: 80 } };
}

export async function listCategoryMatches(pool, query = {}) {
  const where = [];
  const values = [];
  const add = (clause, value) => { values.push(value); where.push(clause.replace("?", `$${values.length}`)); };
  if (query.status) add("p.category_match_status=?", String(query.status));
  if (query.band === "high") where.push("p.category_match_status='recommended' AND p.category_match_confidence>=95");
  if (query.band === "review") where.push("p.category_match_status='recommended' AND p.category_match_confidence>=80 AND p.category_match_confidence<95");
  if (query.band === "calibration") where.push("p.category_match_status='recommended' AND p.category_match_confidence<80");
  if (query.q) {
    values.push(`%${query.q}%`, `%${query.q}%`);
    where.push(`(p.title ILIKE $${values.length - 1} OR p.plid ILIKE $${values.length})`);
  }
  const limit = Math.min(Math.max(Number(query.limit || 50), 1), 100);
  const offset = Math.max(Number(query.offset || 0), 0);
  const countValues = values.slice();
  const total = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM market_products p ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, countValues)).rows[0]?.count || 0);
  values.push(limit, offset);
  const items = (await pool.query(
    `SELECT p.plid,p.title,p.brand,p.image_url,p.product_url,p.original_category_id,p.original_category_path,
       p.recommended_category_id,p.recommended_category_path,p.recommended_candidates,p.category_match_confidence,
       p.category_match_method,p.category_match_status,p.category_match_evidence,p.current_category_id,p.current_category_path
     FROM market_products p ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY CASE p.category_match_status WHEN 'recommended' THEN 0 WHEN 'unmatched' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
       p.category_match_confidence DESC NULLS LAST,p.plid LIMIT $${values.length - 1} OFFSET $${values.length}`, values)).rows;
  return { ok: true, items, total, limit, offset };
}

export async function confirmCategoryMatch(pool, plid, input = {}) {
  const categoryId = text(input.category_id);
  const product = (await pool.query("SELECT * FROM market_products WHERE plid=$1", [plid])).rows[0];
  if (!product) throw new Error("Product not found");
  const category = (await pool.query(
    "SELECT id,name,path FROM market_category_nodes WHERE id=$1 AND source='seller_portal' AND is_current=TRUE AND is_excluded=FALSE AND level=3",
    [categoryId || product.recommended_category_id],
  )).rows[0];
  if (!category) throw new Error("Current level-3 category not found");
  let ruleId = null;
  const keywords = Array.isArray(input.keywords) ? [...new Set(input.keywords.map(normalizeToken).filter(Boolean))].slice(0, 8) : [];
  const originalLeaf = normalizeToken(pathNames(product.original_category_path).at(-1));
  const currentLeaf = normalizeToken(pathNames(category.path).at(-1));
  const safeWholeLegacyMapping = Number(product.category_match_confidence || 0) >= 95 && originalLeaf && originalLeaf === currentLeaf;
  if (input.save_rule === true && (keywords.length || safeWholeLegacyMapping)) {
    ruleId = (await pool.query(
      `INSERT INTO market_category_mapping_rules
        (legacy_category_id,legacy_path,keyword_conditions,current_category_id,confidence,decision_source,enabled,updated_at)
       VALUES ($1,$2::jsonb,$3::jsonb,$4,100,'manual',TRUE,NOW()) RETURNING id`,
      [product.original_category_id,JSON.stringify(product.original_category_path || []),JSON.stringify(keywords),category.id],
    )).rows[0]?.id || null;
  }
  await pool.query(
    `UPDATE market_products SET current_category_id=$2,current_category_path=$3::jsonb,category_match_status='confirmed',
       category_match_confidence=100,category_match_method='manual_confirmation',category_match_rule_id=$4,category_confirmed_at=NOW()
     WHERE plid=$1`,
    [plid,category.id,JSON.stringify(category.path),ruleId],
  );
  await refreshMatchState(pool);
  return { ok: true, plid, current_category_id: category.id, current_category_path: category.path, rule_saved: Boolean(ruleId), rule_id: ruleId };
}

export function categoryMatchBand(confidence) { return band(Number(confidence || 0)); }
