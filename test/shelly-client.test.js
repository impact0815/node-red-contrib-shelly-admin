"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { ShellyClient } = require("../lib/shelly-client");

async function mockServer(responses) {
  const server = http.createServer((request, response) => {
    const body = responses[request.url];
    response.setHeader("content-type", "application/json");
    if (body === undefined) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "missing" }));
      return;
    }
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("normalizes a Gen2+ device and health data", async (t) => {
  const responses = {
    "/shelly": { id: "shellyplus1pm-aabb", mac: "AABBCCDDEEFF", gen: 2, model: "SNSW-001P16EU", app: "Plus1PM", ver: "1.4.4" },
    "/rpc/Shelly.GetDeviceInfo": { id: "shellyplus1pm-aabb", mac: "AABBCCDDEEFF", gen: 2, model: "SNSW-001P16EU", app: "Plus1PM", ver: "1.4.4" },
    "/rpc/Shelly.GetStatus": {
      sys: { uptime: 1234, ram_size: 262144, ram_free: 131072, available_updates: { stable: { version: "1.5.0" } } },
      "wifi:0": { rssi: -61 },
      "switch:0": { temperature: { tC: 51.5 }, apower: 42.2, voltage: 231.1, current: 0.19, aenergy: { total: 1200 } }
    }
  };
  const server = await mockServer(responses);
  t.after(() => server.close());
  const client = new ShellyClient({ port: server.address().port });
  const device = await client.probe("127.0.0.1");
  assert.equal(device.generation, 2);
  assert.equal(device.type, "switch");
  assert.equal(device.health.temperatureC, 51.5);
  assert.equal(device.health.rssi, -61);
  assert.equal(device.health.powerW, 42.2);
  assert.deepEqual(device.capabilities.switches, [0]);
  assert.equal(device.firmware.available.stable, "1.5.0");
});

test("normalizes a Gen1 device and model code", async (t) => {
  const responses = {
    "/shelly": { type: "SHSW-PM", mac: "112233445566", fw: "20230913" },
    "/settings": { device: { type: "SHSW-PM", mac: "112233445566" }, mode: "relay" },
    "/status": { uptime: 500, ram_total: 50000, ram_free: 25000, wifi_sta: { rssi: -72 }, temperature: 48.2, relays: [{ ison: true }], meters: [{ power: 20, voltage: 230 }], update: { has_update: true, new_version: "v2", old_version: "v1" } }
  };
  const server = await mockServer(responses);
  t.after(() => server.close());
  const client = new ShellyClient({ port: server.address().port });
  const device = await client.probe("127.0.0.1");
  assert.equal(device.generation, 1);
  assert.equal(device.model, "Shelly 1PM");
  assert.equal(device.type, "switch");
  assert.equal(device.health.powerW, 20);
  assert.equal(device.firmware.available.hasUpdate, true);
});
