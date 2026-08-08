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

test("restores the hidden department and exactly matches a storefront breadcrumb", () => {
  const product = {
    title: "28 inch Body Wave Lace Front Wig",
    original_category_path: [
      { name: "Beauty" },
      { name: "Hair Care" },
      { name: "Wigs" },
    ],
  };
  const fullPathCandidates = [
    {
      id: "hair-care",
      name: "Hair Care",
      path_id: "wigs-path",
      leaf_name: "Wigs",
      path: [
        { name: "Personal & Lifestyle" },
        { name: "Beauty" },
        { name: "Hair Care" },
        { name: "Wigs" },
      ],
    },
    {
      id: "hair-care",
      name: "Hair Care",
      path_id: "wig-accessories-path",
      leaf_name: "Hair Extension & Wig Accessories",
      path: [
        { name: "Personal & Lifestyle" },
        { name: "Beauty" },
        { name: "Hair Care" },
        { name: "Hair Styling Accessories" },
        { name: "Hair Extension & Wig Accessories" },
      ],
    },
  ];
  const result = recommendCategoryForProduct(product, fullPathCandidates);
  assert.equal(result?.category.path_id, "wigs-path");
  assert.equal(result?.confidence, 99);
  assert.equal(result?.method, "storefront_path_exact_v2");
  assert.equal(result?.category.path.at(0).name, "Personal & Lifestyle");
  assert.equal(result?.category.path.at(-1).name, "Wigs");
});

test("expands the seller portal combined third-column path before matching", () => {
  const product = {
    title: "Natural Black Wig",
    original_category_path: [
      { name: "Beauty" },
      { name: "Hair Care -> Wigs" },
    ],
  };
  const fullPathCandidates = [{
    id: "hair-care",
    name: "Hair Care",
    path_id: "wigs-path",
    leaf_name: "Wigs",
    path: [
      { name: "Personal & Lifestyle" },
      { name: "Beauty" },
      { name: "Hair Care" },
      { name: "Wigs" },
    ],
  }];
  const result = recommendCategoryForProduct(product, fullPathCandidates);
  assert.equal(result?.category.path_id, "wigs-path");
  assert.equal(result?.confidence, 99);
});

test("uses fourth-level leaves such as Vacuum Sealers as real matching evidence", () => {
  const product = {
    title: "Automatic Food Vacuum Sealer",
    original_category_path: [
      { name: "Small Appliances" },
      { name: "Kitchen Appliances" },
      { name: "Vacuum Sealers" },
    ],
  };
  const fullPathCandidates = [{
    id: "kitchen-appliances",
    name: "Kitchen Appliances",
    path_id: "vacuum-sealers-path",
    leaf_name: "Vacuum Sealers",
    path: [
      { name: "HomeSmall Appliances" },
      { name: "Small Appliances" },
      { name: "Kitchen Appliances" },
      { name: "Vacuum Sealers" },
    ],
  }];
  const result = recommendCategoryForProduct(product, fullPathCandidates);
  assert.equal(result?.category.path_id, "vacuum-sealers-path");
  assert.equal(result?.confidence, 99);
});

test("maps the legacy Controllers leaf to the deeper Game Controllers path using title context", () => {
  const product = {
    title: "Wireless Gaming Controller for PS4 Console",
    original_category_path: [{ name: "Controllers" }],
  };
  const fullPathCandidates = [
    {
      id: "gaming-input-devices",
      name: "Input Devices",
      path_id: "game-controllers-path",
      leaf_name: "Game Controllers",
      path: [
        { name: "Consumer Electronics" },
        { name: "Gaming" },
        { name: "Input Devices" },
        { name: "Game Controllers" },
      ],
    },
    {
      id: "musical-instruments",
      name: "Musical Instruments",
      path_id: "midi-controllers-path",
      leaf_name: "MIDI Controllers",
      path: [
        { name: "Consumer Electronics" },
        { name: "Musical Instruments" },
        { name: "Electronic Musical Instruments" },
        { name: "MIDI Controllers" },
      ],
    },
  ];
  const result = recommendCategoryForProduct(product, fullPathCandidates);
  assert.equal(result?.category.path_id, "game-controllers-path");
  assert.ok((result?.confidence || 0) >= 95);
});
