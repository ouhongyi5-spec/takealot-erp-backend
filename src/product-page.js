import puppeteer from "puppeteer";

let browserPromise;
const highPriorityQueue = [];
const normalPriorityQueue = [];
let queueRunning = false;
const inFlightProducts = new Map();
const productCache = new Map();
const PRODUCT_CACHE_MS = Math.max(15_000, Number(process.env.PRODUCT_PAGE_CACHE_MS) || 120_000);
const DIRECT_TIMEOUT_MS = Math.max(3_000, Number(process.env.PRODUCT_DIRECT_TIMEOUT_MS) || 10_000);
let discoveredEndpointTemplate = "https://api.takealot.com/rest/v-1-10-0/product-details/PLID{productlineId}?platform=desktop";
let directFailureCount = 0;
let directDisabledUntil = 0;

async function resetBrowser() {
  const pending = browserPromise;
  browserPromise = undefined;
  if (!pending) return;
  void pending.then((instance) => instance.close()).catch(() => {});
}

async function browser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-crash-reporter",
        "--disable-breakpad",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
      ],
    }).catch((error) => {
      browserPromise = undefined;
      throw error;
    });
  }
  return browserPromise;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isProductPayload(value) {
  return Boolean(value && typeof value === "object" && (value.seller_detail || value.buybox || value.other_offers));
}

function endpointTemplate(url, productlineId) {
  const marker = `PLID${productlineId}`;
  return url.includes(marker) ? url.replace(marker, "PLID{productlineId}") : null;
}

async function readProductDirect(productlineId) {
  if (!discoveredEndpointTemplate || Date.now() < directDisabledUntil) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const url = discoveredEndpointTemplate.replace("{productlineId}", String(productlineId));
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36",
        Referer: `https://www.takealot.com/-/PLID${productlineId}`,
      },
    });
    if (!response.ok) throw new Error(`商品数据直连 ${response.status}`);
    const data = await response.json();
    if (!isProductPayload(data)) throw new Error("商品数据直连返回格式异常");
    directFailureCount = 0;
    return data;
  } catch (error) {
    directFailureCount += 1;
    // A temporary public endpoint block must not break monitoring. Browser
    // fallback remains available and can also teach us a newer API version.
    if (directFailureCount >= 3) {
      directDisabledUntil = Date.now() + 5 * 60_000;
      directFailureCount = 0;
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readProductPageOnce(productlineId, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 35_000;
  const instance = await browser();
  const page = await instance.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1365, height: 768 });
    await page.setCacheEnabled(false);
    await page.setExtraHTTPHeaders({
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
    });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (["image", "font", "media"].includes(request.resourceType())) request.abort();
      else request.continue();
    });

    let settled = false;
    let timeout;
    let resolveProduct;
    let rejectProduct;
    const productResponse = new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("商品页面报价加载超时"));
      }, timeoutMs);
      resolveProduct = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      rejectProduct = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
    });
    page.on("response", async (response) => {
      if (!response.url().includes(`/product-details/PLID${productlineId}`)) return;
      // Chromium can still surface an old conditional response. Ignore it and
      // keep waiting for the cache-busted 200 response instead of failing.
      if (response.status() === 304) return;
      if (response.status() === 429) return rejectProduct?.(new Error("商品页面请求受限 429"));
      try {
        if (!response.ok()) throw new Error(`商品页面报价请求 ${response.status()}`);
        const data = await response.json();
        const learned = endpointTemplate(response.url(), productlineId);
        if (learned) {
          discoveredEndpointTemplate = learned;
          directDisabledUntil = 0;
          directFailureCount = 0;
        }
        resolveProduct?.(data);
      } catch (error) {
        rejectProduct?.(error);
      }
    });

    try {
      await page.goto(`https://www.takealot.com/-/PLID${productlineId}?erp_refresh=${Date.now()}`, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      return await productResponse;
    } catch (error) {
      rejectProduct?.(error);
      await productResponse.catch(() => {});
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    await page.close().catch(() => {});
  }
}

function enqueueRead(productlineId, options) {
  return new Promise((resolve, reject) => {
    const task = { productlineId, options, resolve, reject };
    if (options.priority === "high") highPriorityQueue.push(task);
    else normalPriorityQueue.push(task);
    void drainQueue();
  });
}

async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (highPriorityQueue.length || normalPriorityQueue.length) {
      const task = highPriorityQueue.shift() || normalPriorityQueue.shift();
      try {
        const hardTimeoutMs = (Number(task.options.timeoutMs) || 35_000) + 10_000;
        let timer;
        const hardTimeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("商品页面检查硬超时，已自动跳过")), hardTimeoutMs);
        });
        try {
          task.resolve(await Promise.race([
            readProductPageOnce(task.productlineId, task.options),
            hardTimeout,
          ]));
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        if (/硬超时/.test(error instanceof Error ? error.message : String(error))) await resetBrowser();
        task.reject(error);
      }
    }
  } finally {
    queueRunning = false;
    if (highPriorityQueue.length || normalPriorityQueue.length) void drainQueue();
  }
}

async function readProductPageUncached(productlineId, options = {}) {
  const direct = await readProductDirect(productlineId);
  if (direct) return direct;
  const retryDelays = options.retryDelays || [0];
  let lastError;
  for (const delay of retryDelays) {
    if (delay) await wait(delay);
    try {
      // Each attempt is queued separately, so an automatic-pricing check can
      // jump ahead while a normal full scan is waiting for its retry.
      return await enqueueRead(productlineId, options);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/429|请求受限|超时/.test(message)) throw error;
    }
  }
  throw lastError;
}

export async function readProductPage(productlineId, options = {}) {
  const key = String(productlineId);
  const cached = productCache.get(key);
  if (!options.forceFresh && cached && Date.now() - cached.storedAt < PRODUCT_CACHE_MS) return cached.data;
  if (!options.forceFresh && inFlightProducts.has(key)) return inFlightProducts.get(key);

  const pending = readProductPageUncached(productlineId, options)
    .then((data) => {
      productCache.set(key, { data, storedAt: Date.now() });
      return data;
    })
    .finally(() => inFlightProducts.delete(key));
  inFlightProducts.set(key, pending);
  return pending;
}

export async function closeProductPageBrowser() {
  if (!browserPromise) return;
  const instance = await browserPromise.catch(() => null);
  browserPromise = undefined;
  await instance?.close().catch(() => {});
}
