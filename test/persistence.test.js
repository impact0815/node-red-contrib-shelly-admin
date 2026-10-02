"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ContextPersistence } = require("../lib/persistence");

function fakeNode(failingStore) {
  const stores = new Map();
  return {
    context() {
      return {
        get(key, store, callback) {
          if (typeof store === "function") { callback = store; store = "default"; }
          if (store === failingStore) return callback(new Error("unknown store"));
          callback(null, stores.get(`${store || "default"}:${key}`));
        },
        set(key, value, store, callback) {
          if (typeof store === "function") { callback = store; store = "default"; }
          if (store === failingStore) return callback(new Error("unknown store"));
          const id = `${store || "default"}:${key}`;
          if (value === undefined) stores.delete(id);
          else stores.set(id, value);
          callback(null);
        }
      };
    }
  };
}

test("uses a verified named localfilesystem store", async () => {
  const RED = { settings: { contextStorage: { default: { module: "memory" }, file: { module: "localfilesystem" } } } };
  const persistence = new ContextPersistence(RED, fakeNode(), { store: "file" });
  const info = await persistence.initialize();
  assert.equal(info.durable, true);
  assert.equal(info.mode, "file");
  await persistence.save({ inventory: { schema: 1 } });
  assert.equal((await persistence.load()).inventory.schema, 1);
});

test("falls back to default and reports memory-only behavior", async () => {
  const RED = { settings: { contextStorage: { default: { module: "memory" } } } };
  const persistence = new ContextPersistence(RED, fakeNode("missing"), { store: "missing" });
  const info = await persistence.initialize();
  assert.equal(info.fallback, true);
  assert.equal(info.durable, false);
  assert.match(info.warning, /unavailable/);
});
