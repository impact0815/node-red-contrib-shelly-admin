"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { AnomalyDetector } = require("../lib/anomaly");
const { DeviceHistory } = require("../lib/history");
const { Inventory } = require("../lib/inventory");
const { ContextPersistence, LEGACY_STATE_KEY, STATE_KEY, STATE_SCHEMA } = require("../lib/persistence");
const { ShellyAdminRuntime } = require("../lib/runtime");
const { TemperatureSafety } = require("../lib/safety");

function fakeNode(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    context() {
      return {
        get(key, store, callback) {
          if (typeof store === "function") callback = store;
          callback(null, values.get(key));
        },
        set(key, value, store, callback) {
          if (typeof store === "function") callback = store;
          if (value === undefined) values.delete(key); else values.set(key, value);
          callback(null);
        }
      };
    }
  };
}

test("persistence loads legacy state key and saves explicit state schema 2", async () => {
  const node = fakeNode({ [LEGACY_STATE_KEY]: { schema: 1, inventory: { schema: 1, devices: [], meta: {} } } });
  const persistence = new ContextPersistence({ settings: {} }, node);
  await persistence.initialize();
  const state = await persistence.load();
  assert.equal(state.schema, STATE_SCHEMA);
  assert.equal(state.migration.sourceSchema, 1);
  await persistence.save({ inventory: { schema: 2, devices: [], meta: {} } });
  assert.equal(node.values.get(STATE_KEY).schema, 2);
});

test("a corrupt history section is isolated while inventory remains available", () => {
  const runtime = Object.create(ShellyAdminRuntime.prototype);
  runtime.config = { anomaly: {}, temperature: {} };
  runtime.inventory = new Inventory();
  runtime.history = new DeviceHistory();
  runtime.anomalies = new AnomalyDetector();
  runtime.temperatureSafety = new TemperatureSafety();
  runtime.stateWarnings = [];
  runtime.node = { error() {} };
  runtime.importStateSections({
    inventory: { schema: 1, devices: [{ id: "kept", ip: "192.168.1.9", reachable: true, health: { reachable: true } }], meta: {} },
    history: { schema: 99, devices: {} },
    anomalies: { schema: 1, devices: {} },
    temperatureSafety: { schema: 2, devices: {} }
  });
  assert.equal(runtime.inventory.list().length, 1);
  assert.equal(runtime.inventory.get("kept").ip, "192.168.1.9");
  assert.ok(runtime.stateWarnings.some((warning) => warning.section === "history"));
});
