"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const modules = [
  "../nodes/shelly-admin-config",
  "../nodes/shelly-admin-discovery",
  "../nodes/shelly-admin-monitor",
  "../nodes/shelly-admin-maintenance"
];

test("all Node-RED node modules register their expected types", () => {
  const registered = [];
  const RED = { nodes: { registerType(name, constructor, options) { registered.push({ name, constructor, options }); } } };
  for (const modulePath of modules) require(modulePath)(RED);
  assert.deepEqual(registered.map((entry) => entry.name), [
    "shelly-admin-config",
    "shelly-admin-discovery",
    "shelly-admin-monitor",
    "shelly-admin-maintenance"
  ]);
  assert.equal(typeof registered[0].options.credentials.password, "object");
});
