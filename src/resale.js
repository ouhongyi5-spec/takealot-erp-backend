import { listResaleResults, saveResaleResult } from "./database.js";
import { takealotRequest } from "./takealot.js";
import { readProductPage } from "./product-page.js";

const memoryResults = new Map();
const jobStates = new Map();
const sellerCache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resultCategory(item) {
  if (item?.status === "followed") return "followed";
  if (item?.status === "clear") return "clear";
  const error = String(item?.error || "");
  if (error.includes("公开报价列表中未找到本店铺")) return "not_found";
  if (/429|请求受限/.test(error) || item?.stale) return "rate_limited";
  return "error";
}

async function resolveActiveStore(config, store) {
  const cached = sellerCache.get(store.id);
  if (cached && cached.expiresAt > Date.now()) return cached.store;
  const sellerResponse = await takealotRequest({ ...config, apiKey: store.apiKey }, "seller");
  if (!sellerResponse.ok) throw new Error(`Seller request failed (${sellerResponse.status})`);
  const activeStore = { ...store, sellerId: sellerResponse.data?.seller_id, displayName: sellerResponse.data?.display_name };
  sellerCache.set(store.id, { store: activeStore, expiresAt: Date.now() + 10 * 60_000 });
  return activeStore;
}

async function getAllBuyableOffers(config) {
  const items = [];
  let token = "";
  let pages = 0;
  do {
    const params = new URLSearchParams();
    if (token) {
      params.set("continuation_token", token);
    } else {
      params.set("status", "buyable");
      params.set("limit", "1000");
      params.set("include_count", "true");
      for (const field of ["offer_id", "productline_id", "sku", "title", "image_url", "selling_price"]) {
        params.append("fields", field);
      }
    }
    const response = await takealotRequest(config, "offers", { searchParams: params });
    if (!response.ok) throw new Error(`Offer list failed (${response.status})`);
    items.push(...(response.data?.items || []));
    token = String(response.data?.continuation_token || "");
    pages += 1;
  } while (token && pages < 100);
  return items;
}

function normalizeSeller(seller, price, position) {
  return {
    seller_id: Number(seller?.seller_id || 0) || null,
    display_name: String(seller?.display_name || "未知店铺").trim(),
    price: Number(price || 0) || null,
    position,
  };
}

export async function inspectOffer(store, offer, options = {}) {
  const checkedAt = new Date().toISOString();
  const productlineId = Number(offer.productline_id);
  const base = {
    store_id: store.id,
    offer_id: Number(offer.offer_id),
    productline_id: productlineId || null,
    sku: String(offer.sku || ""),
    title: String(offer.title || ""),
    image_url: String(offer.image_url || ""),
    product_url: productlineId ? `https://www.takealot.com/-/PLID${productlineId}` : null,
    checked_at: checkedAt,
  };
  if (!productlineId) return { ...base, status: "error", own_rank: null, own_price: null, competitors: [], error: "缺少 Productline ID" };

  try {
    const product = await readProductPage(productlineId, options);
    const sellers = [];
    if (product.seller_detail) {
      const selected = product.buybox?.items?.find((item) => item.is_selected) || product.buybox?.items?.[0];
      sellers.push(normalizeSeller(product.seller_detail, selected?.price, 1));
    }
    for (const entry of product.other_offers?.conditions?.flatMap((condition) => condition.items || []) || []) {
      sellers.push(normalizeSeller(entry.seller, entry.price, sellers.length + 1));
    }

    const ownIndex = sellers.findIndex((seller) => Number(seller.seller_id) === Number(store.sellerId));
    const competitors = sellers.filter((seller) => Number(seller.seller_id) !== Number(store.sellerId));
    return {
      ...base,
      product_url: product.desktop_href || base.product_url,
      status: ownIndex < 0 ? "error" : competitors.length ? "followed" : "clear",
      own_rank: ownIndex >= 0 ? ownIndex + 1 : null,
      own_price: ownIndex >= 0 ? sellers[ownIndex].price : Number(offer.selling_price || 0) || null,
      competitors,
      error: ownIndex >= 0 ? null : "公开报价列表中未找到本店铺",
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      own_rank: null,
      own_price: Number(offer.selling_price || 0) || null,
      competitors: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function inspectSingleOffer({ config, pool, store, offer, retryDelays = [0, 5_000, 15_000] }) {
  const activeStore = await resolveActiveStore(config, store);
  const result = await inspectOffer(activeStore, offer, { retryDelays, priority: "high", timeoutMs: 25_000 });
  memoryResults.set(`${store.id}:${result.offer_id}`, result);
  await saveResaleResult(pool, result);
  return result;
}

export async function runResaleMonitor({ config, pool, store, categories = ["all"], trigger = "manual", onProgress = () => {} }) {
  const activeStore = await resolveActiveStore(config, store);
  const offers = await getAllBuyableOffers({ ...config, apiKey: store.apiKey });
  const previous = await listResaleResults(pool, store.id);
  const previousByOffer = new Map(previous.map((item) => [String(item.offer_id), item]));
  const priority = (offer) => {
    const item = previousByOffer.get(String(offer.offer_id));
    if (item?.status === "followed") return 0;
    if (item?.status === "clear") return 1;
    if (/429|请求受限/.test(String(item?.error || ""))) return 2;
    return 3;
  };
  const selectedCategories = new Set(Array.isArray(categories) && categories.length ? categories : ["all"]);
  const selectedOffers = selectedCategories.has("all")
    ? offers
    : offers.filter((offer) => selectedCategories.has(resultCategory(previousByOffer.get(String(offer.offer_id)))));
  selectedOffers.sort((left, right) => priority(left) - priority(right));
  const results = [];
  onProgress({ processed: 0, total: selectedOffers.length, categories: [...selectedCategories], trigger });

  for (let index = 0; index < selectedOffers.length; index += 1) {
    let result = await inspectOffer(activeStore, selectedOffers[index]);
    const prior = previousByOffer.get(String(result.offer_id));
    if (result.status === "error" && prior && Array.isArray(prior.competitors)) {
      result = {
        ...result,
        own_rank: prior.own_rank,
        competitors: prior.competitors,
        last_successful_check_at: prior.checked_at,
        stale: true,
      };
    }
    results.push(result);
    memoryResults.set(`${store.id}:${result.offer_id}`, result);
    await saveResaleResult(pool, result);
    onProgress({ processed: index + 1, total: offers.length, current_offer_id: result.offer_id });
    if (index + 1 < selectedOffers.length) await sleep(8_000);
  }
  return {
    store_id: store.id,
    store_name: activeStore.displayName,
    checked: results.length,
    categories: [...selectedCategories],
    trigger,
    followed: results.filter((item) => item.status === "followed").length,
    clear: results.filter((item) => item.status === "clear").length,
    errors: results.filter((item) => item.status === "error").length,
    checked_at: new Date().toISOString(),
    database: pool ? "configured" : "memory_only",
  };
}

export async function getResaleResults(pool, storeId) {
  const persisted = await listResaleResults(pool, storeId);
  const items = persisted.length
    ? persisted
    : [...memoryResults.values()].filter((item) => item.store_id === storeId);
  return {
    items,
    count: items.length,
    followed: items.filter((item) => item.status === "followed").length,
    clear: items.filter((item) => item.status === "clear").length,
    errors: items.filter((item) => item.status === "error").length,
    last_checked_at: items.reduce((latest, item) => String(item.checked_at) > latest ? String(item.checked_at) : latest, ""),
    database: pool ? "configured" : "memory_only",
    job: jobStates.get(storeId) || { status: "idle" },
  };
}

export function startResaleMonitor(args) {
  const existing = jobStates.get(args.store.id);
  if (existing?.status === "running") return existing;
  const started = {
    status: "running",
    started_at: new Date().toISOString(),
    processed: 0,
    total: 0,
    categories: args.categories || ["all"],
    trigger: args.trigger || "manual",
  };
  jobStates.set(args.store.id, started);
  void runResaleMonitor({
    ...args,
    onProgress(progress) {
      jobStates.set(args.store.id, { ...started, ...progress });
    },
  })
    .then((summary) => {
      jobStates.set(args.store.id, { status: "completed", ...summary });
    })
    .catch((error) => {
      jobStates.set(args.store.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finished_at: new Date().toISOString(),
      });
    });
  return started;
}
