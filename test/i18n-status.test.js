"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { FALLBACKS, interpolate, translate } = require("../lib/node-red");

const parameters = {
  action: "firmware check",
  completed: 24,
  count: 24,
  critical: 1,
  failed: 0,
  offline: 0,
  online: 24,
  phase: "checking",
  processed: 12,
  reachable: 24,
  reason: "test",
  store: "file",
  total: 24,
  timeouts: 1,
  errors: 2,
  updates: 3,
  warnings: 2
};

test("translated values are interpolated even when Node-RED returns a template", () => {
  const node = { _(key) { return key === "status" ? "{{count}} devices ({{online}} online)" : key; } };
  assert.equal(translate(null, node, "status", { count: 24, online: 24 }), "24 devices (24 online)");
});

test("interpolation never leaves a visible moustache placeholder", () => {
  assert.equal(interpolate("{{known}}/{{missing}}", { known: 1 }), "1/");
});

test("all runtime fallbacks and localized placeholder texts render without visible placeholders", () => {
  const templates = [...Object.values(FALLBACKS)];
  for (const locale of ["en-US", "de"]) {
    const directory = path.join(__dirname, "..", "nodes", "locales", locale);
    for (const name of fs.readdirSync(directory).filter((value) => value.endsWith(".json"))) {
      collectStrings(JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")), templates);
    }
  }
  const placeholderTemplates = templates.filter((value) => /{{/.test(value));
  assert.ok(placeholderTemplates.length > 10);
  for (const template of placeholderTemplates) {
    assert.doesNotMatch(interpolate(template, parameters), /{{[^}]+}}/, template);
  }
});

function collectStrings(value, output) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, output));
}
