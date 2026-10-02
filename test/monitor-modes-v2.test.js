"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const monitor = require("../nodes/shelly-admin-monitor");

const observations = [
  { id: "a", lifecycle: "opened" },
  { id: "b", lifecycle: "present" },
  { id: "c", lifecycle: "updated" },
  { id: "d", lifecycle: "cleared" },
  { id: "e", lifecycle: "suppressed" }
];

test("monitor output modes preserve current state and transition semantics", () => {
  assert.deepEqual(monitor.filterObservations(observations, "current").map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(monitor.filterObservations(observations, "transitions").map((item) => item.id), ["a", "c", "d"]);
  assert.equal(monitor.filterObservations(observations, "current-and-transitions").length, 5);
  assert.equal(monitor.normalizeOutputMode("legacy"), "current-and-transitions");
});
