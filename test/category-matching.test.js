import assert from "node:assert/strict";
import test from "node:test";
import { categoryMatchBand, recommendCategoryForProduct } from "../src/category-matching.js";

const candidates = [
  { id: "controllers", name: "Gaming Controllers", path: [{ id: "e", name: "Consumer Electronics" }, { id: "g", name: "Gaming" }, { id: "controllers", name: "Gaming Controllers" }], deep_leaf_names: ["Wireless Controllers", "Gamepads"] },
  { id: "projectors", name: "Projectors", path: [{ id: "e", name: "Consumer Electronics" }, { id: "tv", name: "TV & Audio" }, { id: "projectors", name: "Projectors" }], deep_leaf_names: ["Portable Projectors"] },
];

test("recommends a current category without confirming or replacing the original category", () => {
  const product = { title: "Wireless Gaming Controller for Console", original_category_id: "old-gamepads", original_category_path: [{ id: "old", name: "Game Controllers" }] };
  const result = recommendCategoryForProduct(product, candidates);
  assert.equal(result?.category.id, "controllers");
  assert.equal(product.original_category_id, "old-gamepads");
  assert.equal("current_category_id" in product, false);
});

test("confirmed keyword rules take precedence over heuristic scoring", () => {
  const product = { title: "Pocket LED Projector", original_category_id: "old-video", original_category_path: [] };
  const result = recommendCategoryForProduct(product, candidates, [{ legacy_category_id: "old-video", keyword_conditions: ["projector"], attribute_conditions: {}, current_category_id: "projectors" }]);
  assert.equal(result?.category.id, "projectors");
  assert.equal(result?.confidence, 100);
  assert.equal(result?.method, "saved_rule");
});

test("uses the agreed confidence bands", () => {
  assert.equal(categoryMatchBand(95), "high");
  assert.equal(categoryMatchBand(80), "review");
  assert.equal(categoryMatchBand(79), "calibration");
});

test("downgrades equally scored categories on different paths to calibration", () => {
  const product = {
    title: "Portable Mini Projector",
    original_category_id: "old-projector",
    original_category_path: [{ id: "old", name: "Projector" }],
  };
  const duplicateLeafCandidates = [
    { id: "consumer-projectors", name: "Projectors", path: [{ id: "e", name: "Consumer Electronics" }, { id: "tv", name: "TV & Audio" }, { id: "consumer-projectors", name: "Projectors" }] },
    { id: "office-projectors", name: "Projectors", path: [{ id: "o", name: "Office & Business" }, { id: "f", name: "Office Furniture" }, { id: "office-projectors", name: "Projectors" }] },
  ];
  const result = recommendCategoryForProduct(product, duplicateLeafCandidates);
  assert.equal(result?.confidence, 79);
  assert.match(result?.evidence.join(" ") || "", /同分或近似同分/);
  assert.equal(result?.alternatives[0]?.confidence, 98);
});
