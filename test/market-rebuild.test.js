import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORY_BOUND_REBUILD, validateCategoryBoundRebuild } from "../src/market-rebuild.js";

function validInput() {
  return {
    collectionEnabled: false,
    oldProductCount: 12207,
    confirmedProductCount: 0,
    stagedProductCount: 397,
    test: {
      status: "complete",
      reported_total: 397,
      fetched_count: 397,
      unique_count: 397,
      duplicate_count: 0,
      detail_sample_count: 20,
      detail_mismatch_count: 0,
      public_category_id: "33636",
      public_category_name: "Vacuum Sealers",
      seller_category_path: CATEGORY_BOUND_REBUILD.seller_path_names.map((name, index) => ({ id: `node-${index}`, name })),
    },
  };
}

test("allows only the exact verified 12,207 to 397 Vacuum Sealers rebuild", () => {
  assert.deepEqual(validateCategoryBoundRebuild(validInput()), { ok: true, problems: [] });
});

test("blocks rebuild while general market collection is enabled", () => {
  const input = validInput();
  input.collectionEnabled = true;
  assert.equal(validateCategoryBoundRebuild(input).ok, false);
});

test("blocks rebuild if the active product count changed", () => {
  const input = validInput();
  input.oldProductCount = 12206;
  assert.equal(validateCategoryBoundRebuild(input).ok, false);
});

test("blocks incomplete, duplicated, mismatched, or ambiguous stage data", () => {
  const input = validInput();
  input.test.fetched_count = 396;
  input.test.duplicate_count = 1;
  input.test.detail_mismatch_count = 1;
  input.test.seller_category_path.at(-1).name = "Controllers";
  const result = validateCategoryBoundRebuild(input);
  assert.equal(result.ok, false);
  assert.ok(result.problems.length >= 4);
});

test("blocks deletion when manually confirmed legacy products exist", () => {
  const input = validInput();
  input.confirmedProductCount = 1;
  assert.equal(validateCategoryBoundRebuild(input).ok, false);
});
