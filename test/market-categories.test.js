import assert from "node:assert/strict";
import test from "node:test";
import { extractCategoryTree, extractCmsCategoryNodes, extractMerchandisedDepartments, isMissingNavigationPageError } from "../src/market.js";

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

test("extracts the official merchandised department roots", () => {
  const nodes = extractMerchandisedDepartments({ merchandised_departments:[
    { department_id:3,name:"Books",slug:"books" },
    { department_id:19,name:"Computers",slug:"computers" },
  ] });
  assert.deepEqual(nodes.map((node) => node.id), ["department:books","department:computers"]);
  assert.equal(nodes[1].source_path, "computers");
});

test("extracts CMS page branches and numeric category leaves", () => {
  const parent = { id:"department:computers",level:1,source_path:"computers",path:[{id:"department:computers",name:"Computers"}] };
  const payload = { page:{ widgets:[
    { type:"ImageListWidget",value:{image_list_group:[[
      { title:"Laptops",link_data:{action:"page",parameters:{slug:"computers/laptops"}} },
    ]]}},
    { type:"ContextualNavigationWidget",navigation_links:[
      { display_name:"Accessories",event:{action:"search",parameters:{filters:{Category:"26394"}}} },
    ]},
  ] } };
  const nodes = extractCmsCategoryNodes(payload, parent);
  assert.equal(nodes.find((node) => node.id === "page:computers/laptops")?.parent_id, parent.id);
  assert.equal(nodes.find((node) => node.id === "26394")?.name, "Accessories");
});

test("treats a stale CMS navigation page as a skippable dead branch", () => {
  assert.equal(isMissingNavigationPageError(new Error("Takealot HTTP 404: Requested resource not found")), true);
  assert.equal(isMissingNavigationPageError(new Error("Takealot HTTP 429: Rate limited")), false);
});
