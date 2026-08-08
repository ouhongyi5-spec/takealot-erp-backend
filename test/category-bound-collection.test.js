import assert from "node:assert/strict";
import test from "node:test";
import { BOUND_CATEGORY_TEST, validateBoundCategoryCollection } from "../src/market.js";

test("pins the trial to the exact Vacuum Sealers public and seller categories", () => {
  assert.equal(BOUND_CATEGORY_TEST.public_category_id, "33636");
  assert.deepEqual(BOUND_CATEGORY_TEST.seller_path_names, [
    "HomeSmall Appliances",
    "Small Appliances",
    "Kitchen Appliances",
    "Vacuum Sealers",
  ]);
});

test("accepts a complete unique category crawl with a single seller path", () => {
  const result = validateBoundCategoryCollection({
    reportedTotal: 3,
    fetchedIds: ["PLID1", "PLID2", "PLID3"],
    detailLeafIds: ["33636", "33636"],
    expectedLeafId: "33636",
    sellerPathMatches: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate_count, 0);
  assert.equal(result.detail_mismatch_count, 0);
});

test("rejects missing rows, duplicate PLIDs, breadcrumb mismatches, and ambiguous seller paths", () => {
  const result = validateBoundCategoryCollection({
    reportedTotal: 4,
    fetchedIds: ["PLID1", "PLID1", "PLID2"],
    detailLeafIds: ["33636", "999"],
    expectedLeafId: "33636",
    sellerPathMatches: 2,
  });
  assert.equal(result.ok, false);
  assert.equal(result.duplicate_count, 1);
  assert.equal(result.detail_mismatch_count, 1);
  assert.equal(result.seller_path_match_count, 2);
  assert.ok(result.problems.length >= 4);
});
