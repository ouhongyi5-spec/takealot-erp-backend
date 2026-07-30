import { listResaleResults, saveResaleResult } from "./database.js";
import { takealotRequest } from "./takealot.js";

const memoryResults = new Map();
const jobStates = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function inspectOffer(store, offer) {
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
    const response = await fetch(
      `https://api.takealot.com/rest/v-1-18-0/product-details/PLID${productlineId}?platform=desktop`,
      {
        headers: { Accept: "application/json", "User-Agent": "TakealotERP/1.0" },
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) throw new Error(`Public product API ${response.status}`);
    const product = await response.json();
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

export async function runResaleMonitor({ config, pool, store }) {
  const sellerResponse = await takealotRequest({ ...config, apiKey: store.apiKey }, "seller");
  if (!sellerResponse.ok) throw new Error(`Seller request failed (${sellerResponse.status})`);
  const activeStore = { ...store, sellerId: sellerResponse.data?.seller_id, displayName: sellerResponse.data?.display_name };
  const offers = await getAllBuyableOffers({ ...config, apiKey: store.apiKey });
  const results = [];

  for (let index = 0; index < offers.length; index += 3) {
    const group = offers.slice(index, index + 3);
    const inspected = await Promise.all(group.map((offer) => inspectOffer(activeStore, offer)));
    for (const result of inspected) {
      results.push(result);
      memoryResults.set(`${store.id}:${result.offer_id}`, result);
      await saveResaleResult(pool, result);
    }
    if (index + 3 < offers.length) await sleep(350);
  }
  return {
    store_id: store.id,
    store_name: activeStore.displayName,
    checked: results.length,
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
  const started = { status: "running", started_at: new Date().toISOString() };
  jobStates.set(args.store.id, started);
  void runResaleMonitor(args)
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
