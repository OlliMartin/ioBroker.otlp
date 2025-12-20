"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_sdk_metrics = require("@opentelemetry/sdk-metrics");
var import_exporter_metrics_otlp_http = require("@opentelemetry/exporter-metrics-otlp-http");
var utils = __toESM(require("@iobroker/adapter-core"));
function isNullOrUndefined(obj) {
  return obj === void 0 || obj === null;
}
function parseBool(value, defaultValue) {
  if (value !== void 0 && value !== null && value !== "") {
    return value === true || value === "true" || value === 1 || value === "1";
  }
  return defaultValue || false;
}
function parseNumber(value, defaultValue) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const v = parseFloat(value);
    return isNaN(v) ? defaultValue || 0 : v;
  }
  return defaultValue || 0;
}
function parseNumberWithNull(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const v = parseFloat(value);
    return isNaN(v) ? null : v;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return null;
}
function normalizeStateConfig(customConfig, defaultConfig) {
  if (!customConfig.blockTime && customConfig.blockTime !== "0" && customConfig.blockTime !== 0) {
    if (!customConfig.debounce && customConfig.debounce !== "0" && customConfig.debounce !== 0) {
      customConfig.blockTime = defaultConfig.blockTime || 0;
    } else {
      customConfig.blockTime = parseInt(customConfig.debounce, 10) || 0;
    }
  } else {
    customConfig.blockTime = parseInt(customConfig.blockTime, 10) || 0;
  }
  customConfig.debounceTime = parseNumber(customConfig.debounceTime, 0);
  customConfig.changesOnly = parseBool(customConfig.changesOnly);
  customConfig.ignoreZero = parseBool(customConfig.ignoreZero);
  if (customConfig.round !== null && customConfig.round !== void 0 && customConfig.round !== "") {
    customConfig.round = parseInt(customConfig.round, 10);
    if (!isFinite(customConfig.round) || customConfig.round < 0) {
      customConfig.round = defaultConfig.round;
    } else {
      customConfig.round = Math.pow(10, parseInt(customConfig.round, 10));
    }
  } else {
    customConfig.round = defaultConfig.round;
  }
  customConfig.ignoreAboveNumber = parseNumberWithNull(customConfig.ignoreAboveNumber);
  customConfig.ignoreBelowNumber = parseNumberWithNull(customConfig.ignoreBelowNumber);
  if (customConfig.ignoreBelowNumber === null && parseBool(customConfig.ignoreBelowZero)) {
    customConfig.ignoreBelowNumber = 0;
  }
  customConfig.disableSkippedValueLogging = parseBool(
    customConfig.disableSkippedValueLogging,
    defaultConfig.disableSkippedValueLogging
  );
  customConfig.enableDebugLogs = parseBool(customConfig.enableDebugLogs, defaultConfig.enableDebugLogs);
  customConfig.changesRelogInterval = parseNumber(
    customConfig.changesRelogInterval,
    defaultConfig.changesRelogInterval
  );
  customConfig.changesMinDelta = parseNumber(customConfig.changesMinDelta, defaultConfig.changesMinDelta);
  customConfig.storageType || (customConfig.storageType = false);
  return customConfig;
}
class Otlp extends utils.Adapter {
  // mapping from ioBroker ID to Alias ID
  _aliasMap = {};
  _subscribeAll = false;
  _meterProvider = null;
  _meter = null;
  // Mapping from AliasID to ioBroker ID
  _influxDPs = {};
  _instrumentLookup = {};
  constructor(options = {}) {
    super({
      ...options,
      name: "otlp"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("objectChange", this.onObjectChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    const collectorOptions = {
      url: "https://otlp.acaad.dev:4318/v1/metrics"
    };
    const metricExporter = new import_exporter_metrics_otlp_http.OTLPMetricExporter(collectorOptions);
    this._meterProvider = new import_sdk_metrics.MeterProvider({
      readers: [
        new import_sdk_metrics.PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 1e3
        })
      ]
    });
    this._meter = this._meterProvider.getMeter("ioBroker.otlp", void 0, {});
    await this.loadCustomEntitiesAsync();
    this.createMetricInstruments();
    this.subscribeToStates();
    this.subscribeForeignObjects("*");
  }
  subscribeToStates() {
    if (Object.keys(this._influxDPs).length < 20) {
      this.log.info(`subscribing to ${Object.keys(this._influxDPs).length} data points`);
      for (const _id in this._influxDPs) {
        if (Object.prototype.hasOwnProperty.call(this._influxDPs, _id)) {
          this.subscribeForeignStates(this._influxDPs[_id].realId);
        }
      }
    } else {
      this.log.debug(
        `subscribing to all data points as we have ${Object.keys(this._influxDPs).length} data points to log`
      );
      this._subscribeAll = true;
      this.subscribeForeignStates("*");
    }
  }
  async loadCustomEntitiesAsync() {
    var _a;
    const doc = await this.getObjectViewAsync("system", "custom", {});
    if (!doc || !doc.rows || doc.rows.length == 0) {
      return;
    }
    const filteredRows = doc.rows.filter((row) => !!row.value).filter((row) => {
      var _a2;
      return (_a2 = row.value[this.namespace]) == null ? void 0 : _a2.enabled;
    });
    for (const row of filteredRows) {
      const item = row;
      let id = item.id;
      const realId = id;
      if ((_a = item.value[this.namespace]) == null ? void 0 : _a.aliasId) {
        this._aliasMap[id] = item.value[this.namespace].aliasId;
        this.log.debug(`Found Alias: ${id} --> ${this._aliasMap[id]}`);
        id = this._aliasMap[id];
      }
      this._influxDPs[id] = normalizeStateConfig(
        item.value[this.namespace],
        this.config
      );
      this._influxDPs[id].config = JSON.stringify(item.value[this.namespace]);
      this.log.debug(`enabled logging of ${id}, Alias=${id !== realId} points now activated`);
      this._influxDPs[id].realId = realId;
      await this.writeInitialValue(realId, id);
    }
  }
  createMetricInstruments() {
    this.log.info(`Creating instruments for ${Object.keys(this._influxDPs).length} data points.`);
    for (const trackedDataPointKey of Object.keys(this._influxDPs)) {
      this.createInstrumentForDataPointKey(trackedDataPointKey);
    }
  }
  getInstrumentIdentifier(dataPoint) {
    const { aliasId, realId } = dataPoint;
    return isNullOrUndefined(aliasId) || aliasId.trim() === "" ? realId : aliasId;
  }
  createInstrumentForDataPointKey(trackedDataPointKey) {
    const trackedDataPoint = this._influxDPs[trackedDataPointKey];
    const instrumentIdentifier = this.getInstrumentIdentifier(trackedDataPoint);
    if (isNullOrUndefined(this._meter)) {
      this.log.error("No meter instance was created. This should never happen.");
      return;
    }
    this.log.debug(`Creating gauge with name: '${instrumentIdentifier}'`);
    this._instrumentLookup[instrumentIdentifier] = this._meter.createGauge(instrumentIdentifier);
  }
  removeInstrumentForDataPointKey(trackedDataPointKey) {
    const trackedDataPoint = this._influxDPs[trackedDataPointKey];
    const instrumentIdentifier = this.getInstrumentIdentifier(trackedDataPoint);
    if (!Object.prototype.hasOwnProperty.call(this._instrumentLookup, instrumentIdentifier)) {
      this.log.warn(
        `Expected instrument '${instrumentIdentifier}' to be present, but it was not. Skipping removal.`
      );
      return;
    }
    delete this._instrumentLookup[instrumentIdentifier];
  }
  async onUnload(callback) {
    try {
      this.log.info("Shutting down open telemetry SDK.");
      if (!isNullOrUndefined(this._meterProvider)) {
        await this._meterProvider.forceFlush();
        await this._meterProvider.shutdown();
      }
    } finally {
      callback();
    }
  }
  isTrackedDataPoint(object) {
    if (object === null || object === void 0) {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(object, "aliasId") && Object.prototype.hasOwnProperty.call(object, "enabled");
  }
  onObjectChange(id, obj) {
    var _a, _b;
    const formerAliasId = this._aliasMap[id] ? this._aliasMap[id] : id;
    if (isNullOrUndefined((_b = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.custom) == null ? void 0 : _b[this.namespace])) {
      return;
    }
    const customConfig = obj.common.custom[this.namespace];
    if (!this.isTrackedDataPoint(customConfig)) {
      return;
    }
    if (customConfig.enabled) {
      this.addTrackedAlias(id, customConfig, formerAliasId);
      this.createInstrumentForDataPointKey(id);
    } else {
      this.removeTrackedAlias(id, formerAliasId);
      this.removeInstrumentForDataPointKey(id);
    }
  }
  addTrackedAlias(id, customConfig, formerAliasId) {
    const realId = id;
    let checkForRemove = true;
    if (customConfig.aliasId) {
      if (customConfig.aliasId !== id) {
        this._aliasMap[id] = customConfig.aliasId;
        this.log.debug(`Registered Alias: ${id} --> ${this._aliasMap[id]}`);
        id = this._aliasMap[id];
        checkForRemove = false;
      } else {
        this.log.warn(`Ignoring Alias-ID because identical to ID for ${id}`);
        customConfig.aliasId = "";
      }
    }
    if (checkForRemove && this._aliasMap[id]) {
      this.log.debug(`Removed Alias: ${id} !-> ${this._aliasMap[id]}`);
      delete this._aliasMap[id];
    }
    if (!this._influxDPs[formerAliasId] && !this._subscribeAll) {
      if (Object.keys(this._influxDPs).length >= 19) {
        for (const _id in this._influxDPs) {
          this.unsubscribeForeignStates(this._influxDPs[_id].realId);
        }
        this._subscribeAll = true;
        this.subscribeForeignStates("*");
      } else {
        this.subscribeForeignStates(realId);
      }
    }
    const customSettings = normalizeStateConfig(customConfig, this.config);
    if (this._influxDPs[formerAliasId] && !this._influxDPs[formerAliasId].storageTypeAdjustedInternally && JSON.stringify(customSettings) === this._influxDPs[formerAliasId].config) {
      this.log.debug(`Object ${id} unchanged. Ignore`);
      return;
    }
    if (this._influxDPs[formerAliasId] && this._influxDPs[formerAliasId].relogTimeout) {
      clearTimeout(this._influxDPs[formerAliasId].relogTimeout);
      this._influxDPs[formerAliasId].relogTimeout = null;
    }
    const state = this._influxDPs[formerAliasId] ? this._influxDPs[formerAliasId].state : null;
    const skipped = this._influxDPs[formerAliasId] ? this._influxDPs[formerAliasId].skipped : null;
    const timeout = this._influxDPs[formerAliasId] ? this._influxDPs[formerAliasId].timeout : null;
    this._influxDPs[id] = customSettings;
    this._influxDPs[id].config = JSON.stringify(customSettings);
    this._influxDPs[id].realId = realId;
    this._influxDPs[id].state = state;
    this._influxDPs[id].skipped = skipped;
    this._influxDPs[id].timeout = timeout;
    void this.writeInitialValue(realId, id);
    this.log.info(`enabled logging of ${id}, Alias=${id !== realId}`);
  }
  removeTrackedAlias(id, formerAliasId) {
    if (this._aliasMap[id]) {
      this.log.debug(`Removed Alias: ${id} !-> ${this._aliasMap[id]}`);
      delete this._aliasMap[id];
    }
    id = formerAliasId;
    if (!this._influxDPs[id]) {
      return;
    }
    const relogTimeout = this._influxDPs[id].relogTimeout;
    if (relogTimeout) {
      clearTimeout(relogTimeout);
    }
    const timeout = this._influxDPs[id].timeout;
    if (timeout) {
      clearTimeout(timeout);
    }
    delete this._influxDPs[id];
    this.log.info(`disabled logging of ${id}`);
    if (!this._subscribeAll) {
      this.unsubscribeForeignStates(id);
    }
  }
  async writeInitialValue(realId, id) {
    const state = await this.getForeignStateAsync(realId);
    if (!state || !this._influxDPs[id]) {
      return;
    }
    state.from = `system.adapter.${this.namespace}`;
    this._influxDPs[id].state = state;
    this.log.debug("writeInitialValue called");
  }
  onStateChange(id, state) {
    var _a;
    if (!state) {
      return;
    }
    if (isNullOrUndefined(this._influxDPs[id])) {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(this._instrumentLookup, id)) {
      this.log.warn(`Expected id=${id} to have a valid instrument, but it does not. Skipping data point.`);
      return;
    }
    const instrument = this._instrumentLookup[id];
    this.log.debug(`Received state change for tracked data point: ${id}. Persisting.`);
    const otlpValue = this.transformStateValue(instrument, state.val);
    this.log.debug(`Determined value to write: '${otlpValue}'.`);
    if (isNullOrUndefined(otlpValue)) {
      return;
    }
    instrument.record(otlpValue);
    (_a = this._meterProvider) == null ? void 0 : _a.forceFlush();
  }
  transformStateValue(instrument, iobValue) {
    return parseNumberWithNull(iobValue);
  }
  onMessage(msg) {
    this.log.debug(`Incoming message ${msg.command} from ${msg.from}`);
    this.log.info(JSON.stringify(msg));
  }
}
if (require.main !== module) {
  module.exports = (options) => new Otlp(options);
} else {
  (() => new Otlp())();
}
//# sourceMappingURL=main.js.map
