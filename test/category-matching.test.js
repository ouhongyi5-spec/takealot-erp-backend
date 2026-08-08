import assert from "node:assert/strict";
import test from "node:test";
import { categoryCandidateCount, categoryMatchBand, recommendCategoryForProduct } from "../src/category-matching.js";

const candidates = [
  { id: "controllers", name: "Gaming Controllers", path: [{ id: "e", name: "Consumer Electronics" }, { id: "g", name: "Gaming" }, { id: "controllers", name: "Gaming Controllers" }], deep_leaf_names: ["Wireless Controllers", "Gamepads"] },
  { id: "projectors", name: "Projectors", path: [{ id: "e", name: "Consumer Electronics" }, { id: "tv", name: "TV & Audio" }, { id: "projectors", name: "Projectors" }], deep_leaf_names: ["Portable Projectors"] },
];

test("recognizes the indexed full-path catalog as non-empty before starting a match run", () => {
  assert.equal(categoryCandidateCount({ list: [{ path_id: "wigs-path" }] }), 1);
  assert.equal(categoryCandidateCount({ list: [] }), 0);
});

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

function gamingPath(pathId, segments) {
  return {
    id: segments.at(0).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name: segments.at(0),
    path_id: pathId,
    leaf_name: segments.at(-1),
    path: ["Consumer Electronics", "Gaming", ...segments].map((name) => ({ name })),
  };
}

const controllerSplitCandidates = [
  gamingPath("game-controllers", ["Input Devices", "Game Controllers"]),
  gamingPath("keyboards", ["Input Devices", "Keyboards"]),
  gamingPath("gaming-mice", ["Input Devices", "Gaming Mice"]),
  gamingPath("consoles", ["Video Game Consoles", "Video Game Consoles"]),
  gamingPath("charging", ["Video Game Accessories", "Charging Stations"]),
  gamingPath("cooling", ["Video Game Accessories", "Cooling Fans"]),
  gamingPath("cables", ["Video Game Accessories", "Cables & Adapters"]),
  gamingPath("cases", ["Video Game Accessories", "Hardware Protection", "Cases"]),
  gamingPath("console-covers", ["Video Game Accessories", "Hardware Protection", "Console Covers"]),
  gamingPath("thumb-grips", ["Video Game Accessories", "Hardware Protection", "Covers & Thumb Grips"]),
  gamingPath("battery-packs", ["Video Game Accessories", "Batteries聽& Battery Packs"]),
  gamingPath("racks", ["Video Game Accessories", "Racks & Mounts"]),
  gamingPath("sensor-bars", ["Video Game Accessories", "Sensor Bars"]),
  gamingPath("key-caps", ["Video Game Accessories", "Key Caps & Switches"]),
  gamingPath("memory-cards", ["Video Game Accessories", "Gaming Memory Cards"]),
  {
    id: "memory-card-readers",
    name: "Electronic Accessories",
    path_id: "memory-card-readers",
    leaf_name: "Memory Card Readers",
    path: ["Consumer Electronics", "Electronic Accessories", "Memory Card Readers", "Memory Card Readers"].map((name) => ({ name })),
  },
  {
    id: "screen-protectors",
    name: "Screen Protectors",
    path_id: "screen-protectors",
    leaf_name: "Screen Protectors",
    path: ["Consumer Electronics", "Electronic Accessories", "Screen Protectors", "Screen Protectors"].map((name) => ({ name })),
  },
];

function legacyControllerProduct(title) {
  return { title, original_category_path: [{ name: "Controllers" }] };
}

for (const [title, expectedPath, minimumConfidence] of [
  ["Wireless Gamepad Controller for PS5", "game-controllers", 95],
  ["4K HDMI Wireless Retro Game Stick with Two Controllers", "consoles", 95],
  ["Dual Charging Dock for PS4 Controllers", "charging", 95],
  ["Vertical Cooling Fan Stand Compatible with PS5", "cooling", 95],
  ["USB Charging Cable Compatible with Xbox 360", "cables", 95],
  ["Silicone Controller Case Compatible with Nintendo Switch", "cases", 95],
  ["Analog Thumbstick Caps for Xbox Controller", "thumb-grips", 95],
  ["Wii Remote Sensor Bar", "sensor-bars", 95],
  ["Gaming Chatpad Keyboard for Xbox Controller", "keyboards", 95],
  ["Wireless Controller RGB Hall Effect Remapping", "game-controllers", 95],
  ["PXN V99 Gaming Racing Wheel with Pedals", "game-controllers", 95],
  ["Retro Handheld Game Console with 500 Games", "consoles", 95],
  ["64MB Memory Card Compatible with PS2", "memory-cards", 95],
  ["Wireless Gaming Mouse Compatible with PC", "gaming-mice", 95],
  ["Wireless Phone Game Controler Compatible with PS4 PC iOS Android", "game-controllers", 95],
  ["Dual Charger Compatible with Xbox One X", "charging", 95],
  ["Protective Console Shell Compatible with PS5", "console-covers", 90],
  ["Controller 6 Axis Turbo Compatible with Switch OLED Black", "game-controllers", 95],
  ["2 Pack Remote Controller for Wii with Silicone Case", "game-controllers", 95],
  ["Generic Wireless PS4Controller-Compatible with PlayStation4", "game-controllers", 95],
  ["Thrustmaster SimTask FarmStick PlayStation", "game-controllers", 95],
  ["Sim Racing Load Cell Pedals (3 Pedals) PC", "game-controllers", 95],
  ["32GB Card Reader with FMCB Compatible with PS2 Fat", "memory-cards", 95],
  ["Transparent Card Reader Compatible with PS2 Orange", "memory-card-readers", 95],
  ["8-in-1 Screen Protector Kit Compatible with Switch OLED", "screen-protectors", 95],
  ["12Pieces Arcade Buttons 30mm Compatible with Joystick", "key-caps", 80],
  ["Rubber Silicone Analog Thumbstick Thumb Cover Game Controller Case Skin", "thumb-grips", 95],
  ["Mini wireless keyboard Compatible with controller", "keyboards", 95],
  ["L433 Clear Cover Compatible with PS5 Controller", "cases", 95],
  ["Gold Controller Shell Compatible with PS4", "cases", 95],
  ["GA22 Trigger Gaming Mobile Controller Buttons for Smartphone Gaming", "key-caps", 80],
  ["Thrustmaster Ambidextrous Sol R 1 Flightstick PC", "game-controllers", 95],
  ["Thrustmaster T98P Ferrari 296 Wheel and Pedal", "game-controllers", 95],
  ["128GB MX4SIO Reader Compatible with PS2 Slim", "memory-cards", 95],
  ["Mad Catz C.A.T. 17 Customizable Ergonomic Game Controller", "game-controllers", 95],
]) {
  test(`splits legacy Controllers title into ${expectedPath}: ${title}`, () => {
    const result = recommendCategoryForProduct(legacyControllerProduct(title), controllerSplitCandidates);
    assert.equal(result?.category.path_id, expectedPath);
    assert.ok(Number(result?.confidence || 0) >= minimumConfidence);
    assert.match(result?.method || "", /^legacy_controllers_title_v[34]$/);
  });
}

test("does not misclassify an explicit controller repair component as a complete controller", () => {
  const result = recommendCategoryForProduct(
    legacyControllerProduct("5 Pieces FPC Flex Cable Set Compatible with PS5 Controller"),
    controllerSplitCandidates,
  );
  assert.equal(result, null);
});

test("does not scatter a model-only Controllers title into an unrelated category", () => {
  const result = recommendCategoryForProduct(legacyControllerProduct("SteelSeries Stratus+"), controllerSplitCandidates);
  assert.equal(result, null);
});

test("does not classify a console replacement power supply as a battery pack", () => {
  const result = recommendCategoryForProduct(
    legacyControllerProduct("Power Supply Replacement Compatible with PS4 Pro 70000"),
    controllerSplitCandidates,
  );
  assert.equal(result, null);
});

for (const title of [
  "For Elite Gamepad BDM-010 Front Cover Top Cover",
  "Hyperkin Pro Handle Attachment Set for Nintendo Switch 2 Joy-Cons",
  "2Pieces Steering Wheel Kit Compatible with Switch Red Blue",
  "Compatible with Switch Joy-Con Ergonomic Grip Handle Steering Wheel",
  "Thrustmaster Add-On Leather 28 GT Wheel PC Xbox PS4",
  "Adjustable Dance Strap Compatible with Switch",
  "Internal Heatsink Replacement Compatible with Switch",
  "2TB External HDD Enclosure Compatible with PS4",
]) {
  test(`keeps a controller attachment unmatched: ${title}`, () => {
    const result = recommendCategoryForProduct(legacyControllerProduct(title), controllerSplitCandidates);
    assert.equal(result, null);
  });
}
