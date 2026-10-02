"use strict";

const { iso } = require("./util");

const STATE_SCHEMA = 2;
const STATE_KEY = "shellyAdminStateV2";
const LEGACY_STATE_KEY = "shellyAdminStateV1";

class ContextPersistence {
  constructor(RED, node, options = {}) {
    this.RED = RED;
    this.node = node;
    const requestedStore = String(options.store || "").trim();
    this.preferredStore = requestedStore && requestedStore !== "default" ? requestedStore : undefined;
    this.activeStore = undefined;
    this.info = {
      requestedStore: this.preferredStore || "default",
      activeStore: "default",
      mode: "unknown",
      durable: false,
      fallback: false,
      warning: null,
      warnings: [],
      checkedAt: null,
      stateSchema: STATE_SCHEMA,
      loadedFromKey: null,
      migratedFromSchema: null
    };
  }

  async initialize() {
    const stores = listContextStores(this.RED);
    if (this.preferredStore) {
      try {
        await this.probe(this.preferredStore);
        this.activeStore = this.preferredStore;
      } catch (error) {
        this.activeStore = undefined;
        this.info.fallback = true;
        addWarning(this.info, "unavailable", {
          store: this.preferredStore,
          reason: error.message
        }, `Context store "${this.preferredStore}" is unavailable; the default store is being used (${error.message}).`);
        await this.probe(undefined);
      }
    } else {
      await this.probe(undefined);
    }

    const selected = this.activeStore
      ? stores.find((store) => store.value === this.activeStore)
      : stores.find((store) => store.value === "");
    this.info.activeStore = this.activeStore || "default";
    this.info.mode = selected ? selected.mode : "unknown";
    this.info.durable = this.info.mode === "file";
    this.info.checkedAt = iso();

    const hasFileStore = stores.some((store) => store.durable);
    if (!hasFileStore) {
      addWarning(this.info, "noFileStore", {}, "No file-based Node-RED context store is available. Configure a localfilesystem store; until then data is stored through the default Context store and may be volatile.");
    } else if (!this.info.durable) {
      if (this.info.mode === "memory") {
        addWarning(this.info, "memoryOnly", { store: this.info.activeStore }, `The active Node-RED context store "${this.info.activeStore}" is memory-only; inventory survives redeploys but not process restarts. Configure a localfilesystem store.`);
      } else {
        addWarning(this.info, "unverified", { store: this.info.activeStore }, `The active Context store "${this.info.activeStore}" could not be verified as file-based. Persistence uses only the supported Node-RED Context API.`);
      }
    }
    this.refreshWarning();
    return cloneInfo(this.info);
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
    let value = await contextGet(this.node.context(), STATE_KEY, this.activeStore);
    let key = STATE_KEY;
    if (!value) {
      value = await contextGet(this.node.context(), LEGACY_STATE_KEY, this.activeStore);
      key = LEGACY_STATE_KEY;
    }
    if (!value) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw Object.assign(new Error("Persisted Shelly Admin state is not an object"), { code: "ERR_STATE_FORMAT" });
    }
    const sourceSchema = Number(value.schema) || 1;
    if (![1, STATE_SCHEMA].includes(sourceSchema)) {
      throw Object.assign(new Error(`Unsupported persisted state schema: ${value.schema}`), { code: "ERR_STATE_SCHEMA" });
    }
    this.info.loadedFromKey = key;
    this.info.migratedFromSchema = sourceSchema === STATE_SCHEMA ? null : sourceSchema;
    if (sourceSchema !== STATE_SCHEMA) {
      addWarning(this.info, "stateMigrated", { schema: sourceSchema }, `Persisted state schema ${sourceSchema} will be migrated to schema ${STATE_SCHEMA} without replacing the inventory.`);
    }
    this.refreshWarning();
    return {
      ...value,
      schema: STATE_SCHEMA,
      migration: {
        ...(value.migration || {}),
        sourceSchema,
        sourceKey: key,
        migratedAt: sourceSchema === STATE_SCHEMA ? value.migration && value.migration.migratedAt || null : iso()
      }
    };
  }

  async save(state) {
    const value = {
      ...state,
      schema: STATE_SCHEMA,
      savedAt: iso(),
      persistence: cloneInfo(this.info)
    };
    await contextSet(this.node.context(), STATE_KEY, value, this.activeStore);
    return value.savedAt;
  }

  refreshWarning() {
    this.info.warning = this.info.warnings.map((warning) => warning.message).join(" ") || null;
  }
}

function addWarning(info, code, parameters, message) {
  if (info.warnings.some((warning) => warning.code === code)) return;
  info.warnings.push({ code, parameters, message });
}

function cloneInfo(info) {
  return {
    ...info,
    warnings: info.warnings.map((warning) => ({ ...warning, parameters: { ...warning.parameters } }))
  };
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

function listContextStores(RED) {
  const configured = contextStorageSettings(RED);
  if (!configured || typeof configured !== "object") {
    return [{ name: "default", value: "", module: "memory", mode: "memory", durable: false, isDefault: true }];
  }
  const names = Object.keys(configured).filter((name) => name !== "default");
  const configuredDefault = configured.default;
  const defaultTarget = typeof configuredDefault === "string"
    ? configuredDefault
    : configuredDefault && typeof configuredDefault === "object" ? null : names[0];
  const defaultDefinition = typeof configuredDefault === "object" && configuredDefault !== null
    ? configuredDefault
    : configured[defaultTarget];
  const defaultModule = contextModuleName(defaultDefinition);
  const stores = [{
    name: "default",
    value: "",
    module: defaultModule,
    mode: classifyStore(defaultModule),
    durable: classifyStore(defaultModule) === "file",
    isDefault: true,
    target: defaultTarget || null
  }];
  for (const name of names) {
    const moduleName = contextModuleName(configured[name]);
    const mode = classifyStore(moduleName);
    stores.push({ name, value: name, module: moduleName, mode, durable: mode === "file", isDefault: name === defaultTarget });
  }
  return stores;
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
  LEGACY_STATE_KEY,
  STATE_KEY,
  STATE_SCHEMA,
  classifyStore,
  contextGet,
  contextModuleName,
  contextSet,
  contextStorageSettings,
  listContextStores
};
