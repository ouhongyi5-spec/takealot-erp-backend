const STOPWORDS = new Set([
  "a","an","and","for","from","in","of","on","or","the","to","with","new","set","pack","piece","pieces",
  "product","products","accessory","accessories","other","general","universal","assorted","various",
]);

const matchJob = { running: false, status: "ready_not_started", processed: 0, total: 0, started_at: null, last_error: null };

function text(value) { return value == null ? "" : String(value).trim(); }
function normalizeToken(value) {
  const token = text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (token === "gaming") return "game";
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}
function tokens(value) {
  return [...new Set(text(value).toLowerCase().split(/[^a-z0-9]+/g).map(normalizeToken).filter((token) => token.length > 1 && !STOPWORDS.has(token)))];
}
function splitPathName(value) {
  return text(value).split(/\s*(?:->|→)\s*/g).map(text).filter(Boolean);
}
function pathNames(path) {
  return Array.isArray(path) ? path.flatMap((node) => splitPathName(node?.name)).filter(Boolean) : [];
}
function normalizedPath(path) { return pathNames(path).map((name) => tokens(name).join("")).filter(Boolean); }
function pathKey(parts) { return parts.join("/"); }
function tailMatchCount(left, right) {
  let count = 0;
  while (count < left.length && count < right.length && left.at(-1 - count) === right.at(-1 - count)) count += 1;
  return count;
}
function addIndex(index, key, candidate) {
  if (!key) return;
  const values = index.get(key) || [];
  values.push(candidate);
  index.set(key, values);
}
function distinctCandidates(values = []) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  return values.filter((candidate) => {
    const key = candidate.path_id || `${candidate.id}:${pathKey(candidate._normalizedPath || [])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function buildCandidateCatalog(rows) {
  const list = rows.map((candidate) => {
    const names = pathNames(candidate.path);
    const leafName = candidate.leaf_name || names.at(-1) || candidate.name;
    const normalized = normalizedPath(candidate.path);
    return {
      ...candidate,
      _pathTokens: tokens(names.join(" ")),
      _leafName: leafName,
      _leafTokens: tokens(leafName),
      _normalizedPath: normalized,
    };
  });
  const exact = new Map();
  const storefront = new Map();
  const suffix = new Map();
  const leaf = new Map();
  for (const candidate of list) {
    const parts = candidate._normalizedPath;
    addIndex(exact, pathKey(parts), candidate);
    if (parts.length > 1) addIndex(storefront, pathKey(parts.slice(1)), candidate);
    for (let length = 2; length < parts.length; length += 1) addIndex(suffix, pathKey(parts.slice(-length)), candidate);
    addIndex(leaf, parts.at(-1), candidate);
  }
  return { list, exact, storefront, suffix, leaf };
}
export function categoryCandidateCount(catalog) {
  if (Array.isArray(catalog)) return catalog.length;
  return Array.isArray(catalog?.list) ? catalog.list.length : 0;
}
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

function prepareProduct(product) {
  const title = text(`${product.title || ""} ${product.subtitle || ""} ${product.brand || ""}`);
  const originalNames = pathNames(product.original_category_path);
  return {
    title,
    titleTokens: tokens(title),
    originalNames,
    originalTokens: tokens(originalNames.join(" ")),
    normalizedOriginalPath: normalizedPath(product.original_category_path),
  };
}

function scoreCandidate(productInfo, candidate) {
  const { title, titleTokens, originalTokens, normalizedOriginalPath } = productInfo;
  const candidatePathTokens = candidate._pathTokens;
  const leafName = candidate._leafName;
  const leafTokens = candidate._leafTokens;
  const evidence = [];
  let ruleKeywords = [];
  let score = 0;

  const originalLeaf = normalizedOriginalPath.at(-1);
  const candidateLeaf = candidate._normalizedPath.at(-1);
  if (originalLeaf && originalLeaf === candidateLeaf) { score = 90; evidence.push("原末级类目名称一致"); }
  else {
    const titleLeaf = overlap(leafTokens, titleTokens);
    const legacyPath = overlap(originalTokens, candidatePathTokens);
    const titlePath = overlap(candidatePathTokens, titleTokens);
    score += ratio(leafTokens, titleTokens) * 40;
    score += ratio(originalTokens, candidatePathTokens) * 32;
    score += Math.min(1, titlePath.length / 3) * 14;
    if (leafName.length >= 5 && title.toLowerCase().includes(leafName.toLowerCase())) score += 12;
    const originalLeafTokens = tokens(productInfo.originalNames.at(-1));
    if (originalLeafTokens.length
      && originalLeafTokens.every((token) => leafTokens.includes(token))
      && leafTokens.every((token) => titleTokens.includes(token))) {
      score += 12;
      evidence.push("原末级类目与标题共同指向当前完整路径");
    }
    if (titleLeaf.length) evidence.push(`标题命中：${titleLeaf.slice(0, 4).join("、")}`);
    if (legacyPath.length) evidence.push(`原类目命中：${legacyPath.slice(0, 4).join("、")}`);
    ruleKeywords = [...new Set(titleLeaf)].slice(0, 5);
  }
  const tailMatches = tailMatchCount(normalizedOriginalPath, candidate._normalizedPath);
  if (tailMatches) {
    score += Math.min(24, tailMatches * 8);
    evidence.push(`末端路径连续命中${tailMatches}级`);
  }
  return { score: Math.min(98, Math.round(score)), evidence, ruleKeywords };
}

async function loadCandidates(pool) {
  const rows = (await pool.query(
    `SELECT n.id,n.name,p.path_id,p.full_path AS path,p.leaf_name,p.depth
     FROM market_category_paths p
     JOIN market_category_nodes n ON n.id=p.canonical_category_id
     WHERE p.source='seller_portal' AND p.is_current=TRUE AND p.is_excluded=FALSE
       AND n.source='seller_portal' AND n.is_current=TRUE AND n.is_excluded=FALSE AND n.level=3
     ORDER BY p.leaf_name,p.path_id`,
  )).rows;
  return buildCandidateCatalog(rows);
}

function exactPathRecommendation(productInfo, catalog) {
  const original = productInfo.normalizedOriginalPath;
  if (!original.length) return null;
  const key = pathKey(original);
  const checks = [
    [catalog.exact.get(key), 100, "full_path_exact_v2", "原类目与完整上传路径完全一致"],
    [catalog.storefront.get(key), 99, "storefront_path_exact_v2", "商品页路径与完整上传路径一致，已补回隐藏的一级类目"],
    [original.length >= 2 ? catalog.suffix.get(key) : null, 98, "path_suffix_exact_v2", "原类目与完整上传路径末端连续一致"],
    [original.length === 1 ? catalog.leaf.get(original[0]) : null, 96, "unique_leaf_exact_v2", "原末级类目在完整类目库中唯一"],
  ];
  for (const [rawMatches, confidence, method, evidence] of checks) {
    const matches = distinctCandidates(rawMatches);
    if (matches.length === 1) return { category: matches[0], confidence, method, evidence: [evidence], alternatives: [] };
  }
  return null;
}

function candidateAtPath(catalog, names) {
  const key = pathKey(names.map((name) => tokens(name).join("")).filter(Boolean));
  const matches = distinctCandidates(catalog.exact.get(key));
  return matches.length === 1 ? matches[0] : null;
}

function legacyControllersRecommendation(product, productInfo, catalog) {
  if (normalizeToken(productInfo.originalNames.at(-1)) !== "controller") return undefined;
  const rawTitle = text(product.title || "").replace(/\b(ps[1-5])(?=controller)/gi, "$1 ");
  const title = text(`${rawTitle} ${product.subtitle || ""}`).toLowerCase();
  const gamingContext = /\b(game|gaming|pubg|fps|ps[1-5]?|playstation|xbox|nintendo|switch|wii|joy[ -]?con|pc|android|ios|console|steam|oculus|vr)\b/i.test(title);
  const recommendPath = (tail, confidence, reason) => {
    const category = candidateAtPath(catalog, ["Consumer Electronics", "Gaming", ...tail]);
    return category ? {
      category,
      confidence,
      method: "legacy_controllers_title_v4",
      evidence: ["原类目为 Controllers", reason],
      alternatives: [],
    } : null;
  };
  const recommendFullPath = (fullPath, confidence, reason) => {
    const category = candidateAtPath(catalog, fullPath);
    return category ? {
      category,
      confidence,
      method: "legacy_controllers_title_v4",
      evidence: ["原类目为 Controllers", reason],
      alternatives: [],
    } : null;
  };

  // Product-type words are evaluated before the generic word "controller" so
  // accessories do not inherit the complete-controller category by accident.
  // A title whose grammatical subject is a controller must outrank accessory
  // words appearing later (for example "2 Pack Remote Controller with Case").
  const controllerIsAccessory = /\bcontrol+ers?\s+(?:case|cover|skin|shell|holder|stand|mount|charger|charging|cable|cord|adapter|adaptor|battery|replacement|repair|parts?)\b/i.test(rawTitle);
  const controllerIsPrimary = /^\s*(?:(?:\d+\s*)?(?:pack\s*)?)?(?:(?:generic|wireless|wired|bluetooth|game|gaming|remote|ps[1-5]|xbox|switch|wii)\s*)*control+ers?\b/i.test(rawTitle);
  const explicitCompleteController = /\b(?:wireless|wired|bluetooth|game|gaming|tri[- ]?mode|multiplatform|hall effect|simulation)\b[^,;]{0,40}\bcontrol+ers?\b/i.test(rawTitle);
  const accessoryLeadsController = /\b(?:case|cover|shell|skin|dock|station|charger|cable|adapter|attachment|replacement|buttons?)\b[^,;]{0,45}\b(?:control+ers?|joy[ -]?con|game\s*pad)\b/i.test(rawTitle);
  if (controllerIsPrimary && !controllerIsAccessory && !accessoryLeadsController && gamingContext) {
    return recommendPath(["Input Devices", "Game Controllers"], 98, "标题主体明确为完整游戏手柄，配套附件词不覆盖商品主体");
  }

  // Console replacement power supplies have no safe gaming-specific leaf in
  // the current seller catalog. Do not mislabel them as battery packs.
  if (/\bpower\s+supply\b/i.test(title) && gamingContext) return null;

  // These are controller/console attachments or repair shells, not complete
  // input devices. The current gaming catalog has no safe one-to-one leaf.
  if (/\b(?:handle\s+attachment|attachment\s+set|steering\s+wheel\s+(?:kit|grip)|grip\s+handle\s+steering\s+wheel)\b/i.test(title)) return null;
  if (/\b(?:front|rear|back|top|bottom|middle)\s+(?:cover|shell|panel)\b/i.test(title)) return null;
  if (/\b(?:add[- ]?on\b[^,;]{0,30}\bwheel|dance\s+strap|shooting\s+grip|finger\s+sleeve|internal\s+heatsink|external\s+hdd\s+enclosure)\b/i.test(title)) return null;

  if (/\b(game|retro)\s*stick\b|\bemulator(?:s| console)?\b|\b(?:mini\s+|retro\s+|handheld\s+|tv\s+)?(?:video\s+)?(?:game|gaming)\s*console\b|\b(?:tv|mini|handheld|retro)(?:\s+[a-z0-9-]+)?\s+console\b|\bpsp(?:-style)?\s+console\b|\bhandheld\b.*\b(?:games?|gaming)\b/i.test(title)) {
    return recommendPath(["Video Game Consoles", "Video Game Consoles"], 96, "标题表明商品是游戏主机或游戏棒，不是单独手柄");
  }
  if (/\bsensor\s*bar\b/i.test(title)) {
    return recommendPath(["Video Game Accessories", "Sensor Bars"], 97, "标题明确命中 Sensor Bars");
  }
  if (/\b(?:cooling|cooler)\s*(?:fan|stand)?\b|\bcooling fans?\b/i.test(title) && gamingContext) {
    return recommendPath(["Video Game Accessories", "Cooling Fans"], 96, "标题明确为游戏设备散热配件");
  }
  if (/\b(?:charging|charger|charge)\s*(?:dock|station|stand|base)|\bcontroller\s+charger\b|\bcharging\s+grip\b/i.test(title)
    && !/\b(?:cable|cord|port|board|pcb|socket)\b/i.test(title)) {
    return recommendPath(["Video Game Accessories", "Charging Stations"], 97, "标题明确为手柄或主机充电底座");
  }
  if (/\b(?:fast |dual |4-in-1 )?chargers?\b/i.test(title) && gamingContext
    && !/\b(?:cable|cord|port|board|pcb|socket|power supply)\b/i.test(title)) {
    return recommendPath(["Video Game Accessories", "Charging Stations"], 95, "标题明确为游戏设备充电器");
  }
  if (/\b(?:battery|batteries)\s*(?:pack|packs|case|cover)?\b/i.test(title) && gamingContext) {
    return recommendPath(["Video Game Accessories", "Batteries聽& Battery Packs"], 94, "标题明确为游戏设备电池或电池盒");
  }
  if (/\bpower\s+bank\b/i.test(title) && gamingContext) {
    return recommendPath(["Video Game Accessories", "Batteries聽& Battery Packs"], 94, "标题明确为游戏设备移动电源");
  }
  if (/\b(?:thumb\s*stick|thumbstick|joystick)\s*(?:thumb\s*)?(?:cap|caps|grip|grips|cover|covers)|\bthumb\s+grips?\b/i.test(title)) {
    return recommendPath(["Video Game Accessories", "Hardware Protection", "Covers & Thumb Grips"], 97, "标题明确为摇杆帽或拇指握把");
  }
  if (/\b(?:console\s+cover|face\s*plate|faceplate|decorative\s+strip)\b/i.test(title)) {
    return recommendPath(["Video Game Accessories", "Hardware Protection", "Console Covers"], 94, "标题明确为主机外壳或装饰盖");
  }
  if (/\b(?:replacement panel|frosted panel|console shell|protective console shell|housing case|replacement housing|dust cover)\b/i.test(title) && gamingContext) {
    return recommendPath(["Video Game Accessories", "Hardware Protection", "Console Covers"], 93, "标题表明商品是主机外壳或防尘盖，保留人工复核");
  }
  if (/\bscreen\s+protector(?:s|\s+kit)?\b/i.test(title) && gamingContext) {
    return recommendFullPath(
      ["Consumer Electronics", "Electronic Accessories", "Screen Protectors", "Screen Protectors"],
      96,
      "标题明确为游戏设备屏幕保护膜",
    );
  }
  if (/\b(?:controller|game\s*pads?|joy[ -]?con|switch|ps[1-5]?|xbox|wii)\b.*\b(?:case|skin|silicone cover|protective cover|carry bag|storage bag)\b|\b(?:case|skin|silicone cover|protective cover|carry bag|storage bag)\b.*\b(?:controller|game\s*pads?|joy[ -]?con|switch|ps[1-5]?|xbox|wii)\b/i.test(title)) {
    return recommendPath(["Video Game Accessories", "Hardware Protection", "Cases"], 96, "标题明确为手柄保护壳或收纳包");
  }
  if (/\b(?:clear\s+cover|control+er\s+shell|shell\b[^,;]{0,30}\bjoy[ -]?con|game\s+card\s+case|card\s+holder)\b/i.test(title) && gamingContext) {
    return recommendPath(["Video Game Accessories", "Hardware Protection", "Cases"], 96, "标题明确为手柄或游戏卡保护配件");
  }
  // Explicit repair components do not have a safe one-to-one destination in
  // the seller catalog. This guard must run before the generic cable rule.
  if (/\b(?:flex|fpc)\s*cable\b|\b(?:charging|hdmi|usb)\s+(?:port|board|socket)\b|\b(?:motherboard|circuit board|pcb|joystick module|analog module|conductive rubber|repair kit|replacement parts?)\b/i.test(title)) {
    return null;
  }
  // A storage-card bundle can mention an adapter in its subtitle. Classify it
  // before the generic adapter rule; a reader without storage is a reader.
  if (/\b(?:memory\s+card|card\s+reader|mx4sio\s+reader)\b/i.test(title) && gamingContext) {
    if (/\b(?:\d+\s*(?:gb|mb)|fmcb|memory\s+card|mx4sio)\b/i.test(title)) {
      return recommendPath(["Video Game Accessories", "Gaming Memory Cards"], 97, "标题明确为游戏存储卡或含存储容量的读卡套装");
    }
    return recommendFullPath(
      ["Consumer Electronics", "Electronic Accessories", "Memory Card Readers", "Memory Card Readers"],
      96,
      "标题明确为独立存储卡读卡器",
    );
  }
  if (/\b(?:arcade\b[^,;]{0,30}\bbuttons?|button\s+set|key caps?|switches?|gaming buttons?|game trigger buttons?|gaming triggers?|finger triggers?|triggers?\b[^,;]{0,30}\bbuttons?)\b/i.test(title)) {
    return recommendPath(["Video Game Accessories", "Key Caps & Switches"], 88, "标题表明商品是按键或开关配件，保留人工复核");
  }
  if (/\b(?:cable|cord|adapter|adaptor|converter|dongle|receiver|connector)\b/i.test(title) && gamingContext
    && !/\b(?:controller|gamepad|joypad|joystick)\b.*\b(?:with|and|\+)\b.*\b(?:cable|cord)\b/i.test(title)) {
    return recommendPath(["Video Game Accessories", "Cables & Adapters"], 95, "标题明确为游戏设备线材或转接器");
  }
  if (/\b(?:rack|mount|wall mount|bracket|stand|holder|storage tower)\b/i.test(title) && gamingContext) {
    return recommendPath(["Video Game Accessories", "Racks & Mounts"], 94, "标题明确为游戏设备支架或挂架");
  }
  if (/\b(?:chatpad|gaming keyboard|game keyboard|keyboard|keypad)\b/i.test(title)) {
    return recommendPath(["Input Devices", "Keyboards"], 96, "标题明确为游戏键盘或手柄键盘");
  }
  if (/\bgaming\s+(?:mouse|mice)\b/i.test(title)) {
    return recommendPath(["Input Devices", "Gaming Mice"], 97, "标题明确为游戏鼠标");
  }
  // Strong complete-controller phrases can appear after a brand/model name.
  // They run only after all specific accessory and console rules above.
  if (explicitCompleteController && !controllerIsAccessory && !accessoryLeadsController && gamingContext) {
    return recommendPath(["Input Devices", "Game Controllers"], 98, "标题主体明确为完整游戏手柄，配件词不覆盖商品主体");
  }
  if (/\b(?:game\s*pads?|gaming pads?|joypads?|joysticks?|joy[ -]?cons?|nunchu[ck]+|dual\s*shock|dual\s*sense|xbox pad|split pad|game handle|arcade (?:stick|controller)|fight(?:ing)? stick|farm\s*stick|steering wheel|racing wheels?|game wheel|flight\s*stick|hotas|handbrake|wheel\b[^.]{0,40}\bpedals?|(?:sim\s+)?racing\b[^.]{0,40}\bpedals?)\b/i.test(title)) {
    return recommendPath(["Input Devices", "Game Controllers"], 98, "标题明确为完整游戏手柄或操控器");
  }
  if (/\b(?:control+ers?|joysticks?|remotes?)\b/i.test(title) && gamingContext) {
    return recommendPath(["Input Devices", "Game Controllers"], 97, "标题中的手柄词与游戏平台词共同指向完整游戏手柄");
  }
  if (/\bcontrol+ers?\b/i.test(title) && /\b(?:wireless|wired|bluetooth|vibration|turbo|gyro|hall effect|remapp(?:ing|able)|dual shock|six axis|6 axis)\b/i.test(title)) {
    return recommendPath(["Input Devices", "Game Controllers"], 96, "标题中的连接或操控特征表明商品是完整手柄");
  }

  // Brand/model-only and generic accessory titles remain unmatched for manual
  // calibration instead of being scattered into unrelated paths.
  return null;
}

function recommend(product, inputCandidates, rulesByCategory) {
  const catalog = Array.isArray(inputCandidates) ? buildCandidateCatalog(inputCandidates) : inputCandidates;
  const candidates = catalog.list;
  const productTokens = tokens(`${product.title || ""} ${product.subtitle || ""} ${product.brand || ""}`);
  const productInfo = prepareProduct(product);
  for (const rule of rulesByCategory) {
    if (!ruleApplies(rule, product, productTokens)) continue;
    const currentOptions = candidates.filter((candidate) => candidate.id === rule.current_category_id);
    const current = currentOptions.map((candidate) => ({ candidate, ...scoreCandidate(productInfo, candidate) }))
      .sort((left, right) => right.score - left.score)[0]?.candidate;
    if (current) return { category: current, confidence: 100, method: "saved_rule", evidence: ["已确认永久规则"], alternatives: [] };
  }
  const controllerResult = legacyControllersRecommendation(product, productInfo, catalog);
  if (controllerResult !== undefined) return controllerResult;
  const exact = exactPathRecommendation(productInfo, catalog);
  if (exact) return exact;
  const ranked = candidates.map((candidate) => ({ candidate, ...scoreCandidate(productInfo, candidate) }))
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
    method: "full_path_keyword_v2",
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
    if (!categoryCandidateCount(candidates)) throw new Error("No current seller-portal full-path categories are available");
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
          await pool.query("UPDATE market_products SET category_match_status='unmatched',category_match_method='full_path_keyword_v2',category_matched_at=NOW() WHERE plid=$1", [product.plid]);
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
  const requestedPath = Array.isArray(input.category_path) && input.category_path.length
    ? input.category_path
    : (text(category.id) === text(product.recommended_category_id) ? product.recommended_category_path : []);
  let chosenPath = category.path;
  if (Array.isArray(requestedPath) && requestedPath.length) {
    const validPath = (await pool.query(
      `SELECT full_path FROM market_category_paths
       WHERE canonical_category_id=$1 AND source='seller_portal' AND is_current=TRUE AND is_excluded=FALSE
         AND full_path=$2::jsonb LIMIT 1`,
      [category.id, JSON.stringify(requestedPath)],
    )).rows[0];
    if (validPath?.full_path) chosenPath = validPath.full_path;
  }
  let ruleId = null;
  const keywords = Array.isArray(input.keywords) ? [...new Set(input.keywords.map(normalizeToken).filter(Boolean))].slice(0, 8) : [];
  const originalLeaf = normalizeToken(pathNames(product.original_category_path).at(-1));
  const currentLeaf = normalizeToken(pathNames(chosenPath).at(-1));
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
    [plid,category.id,JSON.stringify(chosenPath),ruleId],
  );
  await refreshMatchState(pool);
  return { ok: true, plid, current_category_id: category.id, current_category_path: chosenPath, rule_saved: Boolean(ruleId), rule_id: ruleId };
}

export function categoryMatchBand(confidence) { return band(Number(confidence || 0)); }
