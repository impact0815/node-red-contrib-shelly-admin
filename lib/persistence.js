"use strict";

const { iso } = require("./util");

const STATE_KEY = "shellyAdminStateV1";

class ContextPersistence {
  constructor(RED, node, options = {}) {
    this.RED = RED;
    this.node = node;
    this.preferredStore = String(options.store || "").trim() || undefined;
    this.activeStore = undefined;
    this.info = {
      requestedStore: this.preferredStore || "default",
      activeStore: "default",
      mode: "unknown",
      durable: false,
      fallback: false,
      warning: null,
      checkedAt: null
    };
  }

  async initialize() {
    const configured = contextStorageSettings(this.RED);
    if (this.preferredStore) {
      try {
        await this.probe(this.preferredStore);
        this.activeStore = this.preferredStore;
      } catch (error) {
        this.activeStore = undefined;
        this.info.fallback = true;
        this.info.warning = `Context store "${this.preferredStore}" is unavailable; using the default store (${error.message})`;
        await this.probe(undefined);
      }
    } else {
      await this.probe(undefined);
    }
    const name = this.activeStore || "default";
    const definition = configured && configured[name];
    const moduleName = contextModuleName(definition);
    this.info.activeStore = name;
    this.info.mode = classifyStore(moduleName);
    this.info.durable = this.info.mode === "file";
    this.info.checkedAt = iso();
    if (!this.info.durable && !this.info.warning) {
      this.info.warning = this.info.mode === "memory"
        ? "The active Node-RED context store is memory-only; inventory survives redeploys but not process restarts. Configure a localfilesystem store."
        : "The active context store could not be verified as file-based. Persistence uses only the supported Node-RED Context API.";
    }
    return { ...this.info };
  }

  async probe(store) {
    const key = `${STATE_KEY}Probe`;
    const value = `probe-${Date.now()}-${Math.random()}`;
    await contextSet(this.node.context(), key, value, store);
    const loaded = await contextGet(this.node.context(), key, store);
    if (loaded !== value) throw Object.assign(new Error("Context store read-after-write verification failed"), { code: "ERR_CONTEXT_PROBE" });
    await contextSet(this.node.context(), key, undefined, store);
  }

  async load() {
    const value = await contextGet(this.node.context(), STATE_KEY, this.activeStore);
    if (!value) return null;
    if (value.schema !== 1) throw Object.assign(new Error(`Unsupported persisted state schema: ${value.schema}`), { code: "ERR_STATE_SCHEMA" });
    return value;
  }

  async save(state) {
    const value = { ...state, schema: 1, savedAt: iso(), persistence: { ...this.info } };
    await contextSet(this.node.context(), STATE_KEY, value, this.activeStore);
    return value.savedAt;
  }
}

function contextStorageSettings(RED) {
  if (!RED || !RED.settings) return null;
  if (RED.settings.contextStorage) return RED.settings.contextStorage;
  if (typeof RED.settings.get === "function") {
    try {
      return RED.settings.get("contextStorage") || null;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function contextModuleName(definition) {
  if (!definition) return "unknown";
  if (typeof definition === "string") return definition;
  if (typeof definition.module === "string") return definition.module;
  if (definition.module && definition.module.name) return definition.module.name;
  return "custom";
}

function classifyStore(moduleName) {
  const value = String(moduleName || "").toLowerCase();
  if (value.includes("localfilesystem")) return "file";
  if (value === "memory" || value.endsWith("/memory")) return "memory";
  if (value === "unknown") return "unknown";
  return "custom";
}

function contextGet(context, key, store) {
  return new Promise((resolve, reject) => {
    const callback = (error, value) => error ? reject(error) : resolve(value);
    try {
      if (store) context.get(key, store, callback);
      else context.get(key, callback);
    } catch (error) {
      reject(error);
    }
  });
}

function contextSet(context, key, value, store) {
  return new Promise((resolve, reject) => {
    const callback = (error) => error ? reject(error) : resolve();
    try {
      if (store) context.set(key, value, store, callback);
      else context.set(key, value, callback);
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  ContextPersistence,
  STATE_KEY,
  classifyStore,
  contextGet,
  contextModuleName,
  contextSet,
  contextStorageSettings
};
