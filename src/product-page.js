import puppeteer from "puppeteer";

let browserPromise;
const highPriorityQueue = [];
const normalPriorityQueue = [];
let queueRunning = false;

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
        resolveProduct?.(await response.json());
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
        task.resolve(await readProductPageOnce(task.productlineId, task.options));
      } catch (error) {
        task.reject(error);
      }
    }
  } finally {
    queueRunning = false;
    if (highPriorityQueue.length || normalPriorityQueue.length) void drainQueue();
  }
}

export async function readProductPage(productlineId, options = {}) {
  const retryDelays = options.retryDelays || [0, 60_000, 300_000, 900_000];
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

export async function closeProductPageBrowser() {
  if (!browserPromise) return;
  const instance = await browserPromise.catch(() => null);
  browserPromise = undefined;
  await instance?.close().catch(() => {});
}
