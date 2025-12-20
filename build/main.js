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
var import_exporter_metrics_otlp_grpc = require("@opentelemetry/exporter-metrics-otlp-grpc");
var import_resources = require("@opentelemetry/resources");
var utils = __toESM(require("@iobroker/adapter-core"));
function isNullOrUndefined(obj) {
  return obj === void 0 || obj === null;
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
function transformAttributes(attributesFromConfig) {
  if (!attributesFromConfig) {
    return {};
  }
  return attributesFromConfig.reduce((prev, tuple) => ({ ...prev, [tuple.key]: tuple.value }), {});
}
class Otlp extends utils.Adapter {
  // mapping from ioBroker ID to Alias ID
  _aliasMap = {};
  _subscribeAll = false;
  _meterProvider = null;
  _meter = null;
  _connected = false;
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
    this.setConnected(false);
    const { protocol, otlProtocol, host, port } = this.config;
    if (isNullOrUndefined(protocol) || isNullOrUndefined(otlProtocol) || isNullOrUndefined(host) || isNullOrUndefined(port)) {
      this.log.error(
        "At least one required property was not set. Cannot start. Please adjust the configuration."
      );
      return;
    }
    const { headers, resourceAttributes } = this.config;
    let otlpEndpoint = null;
    let metricExporter = null;
    if (otlProtocol === "http") {
      otlpEndpoint = `${protocol}://${host}:${port}/v1/metrics`;
      const collectorOptions = {
        url: otlpEndpoint,
        headers
      };
      metricExporter = new import_exporter_metrics_otlp_http.OTLPMetricExporter(collectorOptions);
    }
    if (otlProtocol === "grpc") {
      otlpEndpoint = `${protocol}://${host}:${port}/otlp`;
      const collectorOptions = {
        url: otlpEndpoint,
        headers
      };
      metricExporter = new import_exporter_metrics_otlp_grpc.OTLPMetricExporter(collectorOptions);
    }
    if (!otlpEndpoint || !metricExporter) {
      this.log.error("Could not create metric exporter. Cannot continue. Stopping.");
      return;
    }
    this.log.info(`Connecting to OTLP endpoint: ${otlpEndpoint}`);
    const resource = !!resourceAttributes && Object.keys(resourceAttributes).length > 0 ? (0, import_resources.resourceFromAttributes)(transformAttributes(resourceAttributes)) : (0, import_resources.emptyResource)();
    this._meterProvider = new import_sdk_metrics.MeterProvider({
      readers: [
        new import_sdk_metrics.PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 1e3
        })
      ],
      resource
    });
    this._meter = this._meterProvider.getMeter("ioBroker.otlp", void 0, {});
    this.setConnected(true);
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
      this._influxDPs[id] = item.value[this.namespace];
      this._influxDPs[id].config = JSON.stringify(item.value[this.namespace]);
      this.log.debug(`enabled logging of ${id}, Alias=${id !== realId} points now activated`);
      this._influxDPs[id].realId = realId;
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
    if (!Object.prototype.hasOwnProperty.call(this._influxDPs, trackedDataPointKey)) {
      this.log.warn(
        `Expected instrument '${trackedDataPointKey}' to be present in data points, but it was not. Skipping.`
      );
      return;
    }
    const trackedDataPoint = this._influxDPs[trackedDataPointKey];
    const instrumentIdentifier = this.getInstrumentIdentifier(trackedDataPoint);
    if (isNullOrUndefined(this._meter)) {
      this.log.error("No meter instance was created. This should never happen.");
      return;
    }
    this.log.debug(`Creating gauge with name: '${instrumentIdentifier}' (key=${trackedDataPointKey})`);
    this._instrumentLookup[trackedDataPointKey] = this._meter.createGauge(instrumentIdentifier);
  }
  removeInstrumentForDataPointKey(trackedDataPointKey) {
    if (!Object.prototype.hasOwnProperty.call(this._instrumentLookup, trackedDataPointKey)) {
      this.log.warn(
        `Expected instrument '${trackedDataPointKey}' to be present, but it was not. Skipping removal.`
      );
      return;
    }
    this.log.debug(`Removing instrument with id: '${trackedDataPointKey}'.`);
    delete this._instrumentLookup[trackedDataPointKey];
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
      void this.writeInitialValue(id);
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
    const customSettings = customConfig;
    const state = this._influxDPs[formerAliasId] ? this._influxDPs[formerAliasId].state : null;
    const skipped = this._influxDPs[formerAliasId] ? this._influxDPs[formerAliasId].skipped : null;
    this._influxDPs[id] = customSettings;
    this._influxDPs[id].config = JSON.stringify(customSettings);
    this._influxDPs[id].realId = realId;
    this._influxDPs[id].state = state;
    this._influxDPs[id].skipped = skipped;
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
    delete this._influxDPs[id];
    this.log.info(`disabled logging of ${id}`);
    if (!this._subscribeAll) {
      this.unsubscribeForeignStates(id);
    }
  }
  async writeInitialValue(id) {
    const state = await this.getForeignStateAsync(id);
    if (!state || !this._influxDPs[id]) {
      return;
    }
    state.from = `system.adapter.${this.namespace}`;
    this._influxDPs[id].state = state;
    this.recordStateByIobId(id, state);
  }
  onStateChange(id, state) {
    if (!state) {
      return;
    }
    if (isNullOrUndefined(this._influxDPs[id])) {
      return;
    }
    this.recordStateByIobId(id, state);
  }
  recordStateByIobId(id, state) {
    if (!Object.prototype.hasOwnProperty.call(this._influxDPs, id)) {
      this.log.warn(`Expected id=${id} to have a valid data point configuration, but it does not. Skipping.`);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(this._instrumentLookup, id)) {
      this.log.warn(`Expected id=${id} to have a valid instrument, but it does not. Skipping.`);
      return;
    }
    const dataPointCfg = this._influxDPs[id];
    const instrument = this._instrumentLookup[id];
    this.log.debug(`Received state change for tracked data point: ${id}. Persisting.`);
    const otlpValue = this.transformStateValue(state.val);
    this.log.debug(`Determined value to write: '${otlpValue}'.`);
    if (isNullOrUndefined(otlpValue)) {
      return;
    }
    instrument.record(otlpValue, transformAttributes(dataPointCfg == null ? void 0 : dataPointCfg.attributes));
  }
  transformStateValue(iobValue) {
    return parseNumberWithNull(iobValue);
  }
  onMessage(msg) {
    this.log.debug(`Incoming message ${msg.command} from ${msg.from}`);
    this.log.info(JSON.stringify(msg));
  }
  setConnected(isConnected) {
    if (this._connected !== isConnected) {
      this._connected = isConnected;
      void this.setState(
        "info.connection",
        this._connected,
        true,
        (error) => (
          // analyse if the state could be set (because of permissions)
          error ? this.log.error(`Can not update this._connected state: ${error}`) : this.log.debug(`connected set to ${this._connected}`)
        )
      );
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Otlp(options);
} else {
  (() => new Otlp())();
}
//# sourceMappingURL=main.js.map
