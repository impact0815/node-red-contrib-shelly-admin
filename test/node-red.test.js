"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { settleNodeCallback, translate } = require("../lib/node-red");
const { ShellyAdminRuntime } = require("../lib/runtime");

const root = path.resolve(__dirname, "..");

function keys(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" && !Array.isArray(child) ? keys(child, name) : [name];
  }).sort();
}

test("translation helper falls back to English when translators are absent or broken", () => {
  assert.equal(translate({}, {}, "shelly-admin-config.status.loading"), "loading inventory");
  const broken = { _() { throw new TypeError("translator unavailable"); } };
  assert.equal(
    translate(broken, broken, "shelly-admin-config.status.readyPersistent", { count: 2 }),
    "2 devices · persistent"
  );
});

test("async callback rejection is reported without becoming unhandled", async () => {
  const errors = [];
  let completedWith;
  const node = { error(error) { errors.push(error); } };
  await assert.doesNotReject(settleNodeCallback(
    node,
    async () => { throw new Error("callback failed"); },
    (error) => { completedWith = error; }
  ));
  assert.equal(errors[0].message, "callback failed");
  assert.equal(completedWith.message, "callback failed");
});

test("runtime initialization rejection is observed and emitted safely", async () => {
  const node = {
    errors: [],
    error(error) { this.errors.push(error); },
    context() {
      return {
        get(_key, callback) { callback(new Error("storage failed")); },
        set(_key, _value, callback) { callback(new Error("storage failed")); }
      };
    }
  };
  const runtime = new ShellyAdminRuntime({ settings: {} }, node, { policies: "[]" });
  const runtimeErrors = [];
  runtime.on("runtime-error", (error) => runtimeErrors.push(error));
  await assert.rejects(runtime.ready, /storage failed/);
  assert.equal(runtimeErrors[0].operation, "initialize");
});

test("English and German locale catalogs have identical keys", () => {
  const localeFiles = fs.readdirSync(path.join(root, "nodes/locales/en-US")).filter((file) => file.endsWith(".json"));
  for (const file of localeFiles) {
    const english = JSON.parse(fs.readFileSync(path.join(root, "nodes/locales/en-US", file), "utf8"));
    const german = JSON.parse(fs.readFileSync(path.join(root, "nodes/locales/de", file), "utf8"));
    assert.deepEqual(keys(german), keys(english), `${file} locale keys differ`);
  }
});

test("runtime and editor sources contain no unguarded direct node translation calls", () => {
  const files = fs.readdirSync(path.join(root, "nodes"))
    .filter((file) => file.endsWith(".js") || file.endsWith(".html"));
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, "nodes", file), "utf8");
    assert.doesNotMatch(source, /\b(?:node|this)\._\s*\(/, file);
  }
});
