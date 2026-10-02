"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Inventory } = require("../lib/inventory");
const { availabilityObservation } = require("../lib/runtime");

function device() {
  return { id: "shelly-a", ip: "192.168.1.2", model: "Shelly", generation: 2, reachable: true, health: { reachable: true } };
}

test("one incident opens once, records repeated occurrences, and clears exactly once", () => {
  const inventory = new Inventory();
  inventory.upsert(device(), { timestamp: "2026-10-02T10:00:00.000Z" });
  const first = inventory.markUnreachable("shelly-a", Object.assign(new Error("timeout"), { code: "ETIMEDOUT", retryable: true }), { timestamp: "2026-10-02T10:01:00.000Z", operation: "monitor" });
  const repeat = inventory.markUnreachable("shelly-a", Object.assign(new Error("timeout again"), { code: "ETIMEDOUT" }), { timestamp: "2026-10-02T10:02:00.000Z", operation: "monitor" });
  assert.equal(availabilityObservation(first).lifecycle, "opened");
  assert.equal(availabilityObservation(repeat), null);
  assert.equal(inventory.get("shelly-a").lastError.occurrenceCount, 2);

  const recovered = inventory.upsert(device(), { timestamp: "2026-10-02T10:03:00.000Z", resolution: "monitor-probe-succeeded" });
  const cleared = availabilityObservation(recovered);
  assert.equal(cleared.schema, "shelly-admin.observation/2");
  assert.equal(cleared.lifecycle, "cleared");
  assert.equal(cleared.openedAt, "2026-10-02T10:01:00.000Z");
  assert.equal(cleared.clearedAt, "2026-10-02T10:03:00.000Z");
  assert.equal(cleared.observation.resolvedError.resolution, "monitor-probe-succeeded");
  assert.equal(inventory.get("shelly-a").lastError, undefined);
  assert.equal(inventory.get("shelly-a").lastResolvedError.occurrenceCount, 2);
  assert.equal(inventory.list().length, 1);

  const normal = inventory.upsert(device(), { timestamp: "2026-10-02T10:04:00.000Z" });
  assert.equal(normal.kind, "updated");
  assert.equal(availabilityObservation(normal), null);
});

test("legacy active and resolved errors migrate without dropping inventory", () => {
  const inventory = new Inventory({
    schema: 1,
    devices: [
      { ...device(), id: "a", reachable: false, lastChecked: "2026-10-01T10:00:00.000Z", lastError: { code: "ETIMEDOUT", message: "old", at: "2026-10-01T10:00:00.000Z" } },
      { ...device(), id: "b", lastResolvedError: { code: "ECONNRESET", message: "old", at: "2026-09-01T10:00:00.000Z", resolvedAt: "2026-09-01T10:01:00.000Z" } }
    ],
    meta: {}
  });
  assert.equal(inventory.list().length, 2);
  assert.equal(inventory.get("a").lastError.status, "active");
  assert.equal(inventory.get("a").lastError.occurrenceCount, 1);
  assert.equal(inventory.get("b").lastResolvedError.status, "resolved");
  assert.equal(inventory.export().schema, 2);
});
