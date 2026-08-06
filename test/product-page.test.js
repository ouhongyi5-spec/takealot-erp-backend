import test from "node:test";
import assert from "node:assert/strict";
import { readProductPage } from "../src/product-page.js";

test("uses public product JSON and deduplicates the same PLID", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.match(String(url), /product-details\/PLID987654/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({
      seller_detail: { seller_id: 1, display_name: "Test" },
      buybox: { items: [{ is_selected: true, price: 100 }] },
      other_offers: { conditions: [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const [left, right] = await Promise.all([
      readProductPage(987654),
      readProductPage(987654),
    ]);
    assert.equal(left.seller_detail.display_name, "Test");
    assert.equal(right.seller_detail.display_name, "Test");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
