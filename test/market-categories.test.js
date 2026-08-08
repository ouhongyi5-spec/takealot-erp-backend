import assert from "node:assert/strict";
import test from "node:test";
import { extractCategoryTree } from "../src/market.js";

test("extracts a nested Takealot category facet into stable paths", () => {
  const payload = { sections:{ filters:[{ type:"Category", items:[
    { id:"1", name:"Electronics", children:[{ id:"2", name:"TV & Audio", children:[{ id:"3", name:"Projectors" }] }] },
    { id:"4", name:"Books", children:[{ id:"5", name:"Fiction" }] },
  ] }] } };
  const nodes = extractCategoryTree(payload);
  assert.equal(nodes.find((node) => node.id === "3")?.level, 3);
  assert.deepEqual(nodes.find((node) => node.id === "3")?.path.map((node) => node.name), ["Electronics","TV & Audio","Projectors"]);
  assert.equal(nodes.find((node) => node.id === "2")?.parent_id, "1");
});
