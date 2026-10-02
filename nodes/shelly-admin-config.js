"use strict";

const { ShellyAdminRuntime } = require("../lib/runtime");
const { publicError } = require("../lib/util");

module.exports = function registerShellyAdminConfig(RED) {
  function ShellyAdminConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    try {
      node.runtime = new ShellyAdminRuntime(RED, node, config, node.credentials || {});
      node.runtime.on("ready", (state) => {
        const persistenceKey = state.persistence && state.persistence.durable ? "status.readyPersistent" : "status.readyVolatile";
        node.status({ fill: state.persistence && state.persistence.durable ? "green" : "yellow", shape: "dot", text: node._(`shelly-admin-config.${persistenceKey}`, { count: state.inventoryCount }) });
        if (state.persistence && state.persistence.warning) node.warn(state.persistence.warning);
      });
      node.runtime.on("runtime-error", (error) => node.error(error.message));
      node.status({ fill: "grey", shape: "ring", text: node._("shelly-admin-config.status.loading") });
    } catch (error) {
      node.initializationError = publicError(error, { operation: "initialize" });
      node.status({ fill: "red", shape: "ring", text: node._("shelly-admin-config.status.error") });
      node.error(error.message);
    }
    node.on("close", async (_removed, done) => {
      try {
        if (node.runtime) await node.runtime.close();
        done();
      } catch (error) {
        done(error);
      }
    });
  }

  RED.nodes.registerType("shelly-admin-config", ShellyAdminConfigNode, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" }
    }
  });
};
