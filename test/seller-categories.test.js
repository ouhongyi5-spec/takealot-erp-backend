import assert from "node:assert/strict";
import test from "node:test";
import { extractSellerCategoryNodes, validateSellerCategoryTree } from "../src/seller-categories.js";

function fixture() {
  const departments = [];
  for (let root = 1; root <= 7; root += 1) {
    departments.push({
      categoryId: `d${root}`,
      displayName: root === 7 ? "Books & Courses" : `Department ${root}`,
      subCategories: [1, 2].map((sub) => ({
        categoryId: `d${root}-s${sub}`,
        displayName: `Sub ${root}.${sub}`,
        subCategories: [1, 2].map((leaf) => ({
          categoryId: `d${root}-s${sub}-c${leaf}`,
          displayName: `Category ${root}.${sub}.${leaf}`,
          selectable: true,
        })),
      })),
    });
  }
  return { data: { departments } };
}

test("normalizes Add to Takealot's Catalogue hierarchy and stable paths", () => {
  const nodes = extractSellerCategoryNodes(fixture());
  const leaf = nodes.find((node) => node.id === "d2-s1-c2");
  assert.equal(leaf.level, 3);
  assert.deepEqual(leaf.path.map((node) => node.name), ["Department 2", "Sub 2.1", "Category 2.1.2"]);
  assert.equal(leaf.source, "seller_portal");
});

test("excludes the entire Books branch without excluding Media globally", () => {
  const payload = fixture();
  payload.data.departments[0].displayName = "Media";
  const nodes = extractSellerCategoryNodes(payload);
  assert.equal(nodes.find((node) => node.id === "d1")?.is_excluded, false);
  assert.equal(nodes.find((node) => node.id === "d7-s1-c1")?.is_excluded, true);
});

test("accepts a complete seller tree and reports each level", () => {
  const result = validateSellerCategoryTree(extractSellerCategoryNodes(fixture()));
  assert.equal(result.valid, true);
  assert.deepEqual(result.counts.by_level, { 1: 6, 2: 12, 3: 24, 4: 0, 5: 0, 6: 0 });
  assert.equal(result.counts.excluded_books, 7);
});

test("rejects partial category payloads before replacing the current tree", () => {
  const result = validateSellerCategoryTree(extractSellerCategoryNodes({ departments: [{ id: "one", name: "Only one" }] }));
  assert.equal(result.valid, false);
  assert.match(result.problems.join(" "), /department roots/);
});
