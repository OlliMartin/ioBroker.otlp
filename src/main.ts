/*
 * Created with @iobroker/create-adapter v3.1.2
 */

import type { Gauge, Meter as IMeter } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { OTLPMetricExporterOptions } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPHttpExporter } from '@opentelemetry/exporter-metrics-otlp-http';

import * as utils from '@iobroker/adapter-core';
import type { InfluxDBAdapterConfig, InfluxDbCustomConfig, InfluxDbCustomConfigTyped } from './types';

function isNullOrUndefined(obj?: any): obj is null {
    return obj === undefined || obj === null;
}

function parseBool(value: any, defaultValue?: boolean): boolean {
    if (value !== undefined && value !== null && value !== '') {
        return value === true || value === 'true' || value === 1 || value === '1';
    }
    return defaultValue || false;
}

function parseNumber(value: any, defaultValue?: number): number {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string') {
        const v = parseFloat(value);
        return isNaN(v) ? defaultValue || 0 : v;
    }
    return defaultValue || 0;
}

function parseNumberWithNull(value: any): number | null {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string') {
        const v = parseFloat(value);
        return isNaN(v) ? null : v;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    return null;
}

function normalizeStateConfig(
    customConfig: InfluxDbCustomConfig,
    defaultConfig: InfluxDBAdapterConfig,
): InfluxDbCustomConfigTyped {
    // debounceTime and debounce compatibility handling
    if (!customConfig.blockTime && customConfig.blockTime !== '0' && customConfig.blockTime !== 0) {
        if (!customConfig.debounce && customConfig.debounce !== '0' && customConfig.debounce !== 0) {
            customConfig.blockTime = defaultConfig.blockTime || 0;
        } else {
            customConfig.blockTime = parseInt(customConfig.debounce as string, 10) || 0;
        }
    } else {
        customConfig.blockTime = parseInt(customConfig.blockTime as string, 10) || 0;
    }

    customConfig.debounceTime = parseNumber(customConfig.debounceTime, 0);
    customConfig.changesOnly = parseBool(customConfig.changesOnly);
    customConfig.ignoreZero = parseBool(customConfig.ignoreZero);

    // round
    if (customConfig.round !== null && customConfig.round !== undefined && customConfig.round !== '') {
        customConfig.round = parseInt(customConfig.round as string, 10);
        if (!isFinite(customConfig.round) || customConfig.round < 0) {
            customConfig.round = defaultConfig.round;
        } else {
            customConfig.round = Math.pow(10, parseInt(customConfig.round as unknown as string, 10));
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
        defaultConfig.disableSkippedValueLogging,
    );
    customConfig.enableDebugLogs = parseBool(customConfig.enableDebugLogs, defaultConfig.enableDebugLogs);
    customConfig.changesRelogInterval = parseNumber(
        customConfig.changesRelogInterval,
        defaultConfig.changesRelogInterval as number,
    );
    customConfig.changesMinDelta = parseNumber(customConfig.changesMinDelta, defaultConfig.changesMinDelta);

    customConfig.storageType ||= false;
    return customConfig as InfluxDbCustomConfigTyped;
}

interface SavedInfluxDbCustomConfig extends InfluxDbCustomConfigTyped {
    config: string;
    realId: string;
    storageTypeAdjustedInternally: boolean;
    relogTimeout: NodeJS.Timeout | null;
    state: ioBroker.State | null | undefined;
    skipped: ioBroker.State | null | undefined;
    timeout: NodeJS.Timeout | null;
    lastLogTime?: number;
}

class Otlp extends utils.Adapter {
    declare config: InfluxDBAdapterConfig;

    // mapping from ioBroker ID to Alias ID
    private readonly _aliasMap: { [ioBrokerId: string]: string } = {};
    private _subscribeAll = false;

    private _meterProvider: MeterProvider | null = null;
    private _meter: IMeter | null = null;

    // Mapping from AliasID to ioBroker ID
    private readonly _influxDPs: {
        [ioBrokerId: string]: SavedInfluxDbCustomConfig;
    } = {};

    private readonly _instrumentLookup: Record<string, Gauge> = {};

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'otlp',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        // TODO: Load gRPC/http-proto config
        // -> Create http/grpc exporter respectively

        const collectorOptions: OTLPMetricExporterOptions = {
            url: 'https://otlp.acaad.dev:4318/v1/metrics',
        };

        const metricExporter = new OTLPHttpExporter(collectorOptions);

        this._meterProvider = new MeterProvider({
            readers: [
                new PeriodicExportingMetricReader({
                    exporter: metricExporter,
                    exportIntervalMillis: 1000,
                }),
            ],
        });

        // TODO: Allow providing meter name from adapter config.
        this._meter = this._meterProvider.getMeter('ioBroker.otlp', undefined, {});

        await this.loadCustomEntitiesAsync();

        this.createMetricInstruments();

        this.subscribeToStates();
        this.subscribeForeignObjects('*');
    }

    private subscribeToStates(): void {
        // If we have less than 20 datapoints, subscribe individually, else subscribe to all
        if (Object.keys(this._influxDPs).length < 20) {
            this.log.info(`subscribing to ${Object.keys(this._influxDPs).length} data points`);
            for (const _id in this._influxDPs) {
                if (Object.prototype.hasOwnProperty.call(this._influxDPs, _id)) {
                    this.subscribeForeignStates(this._influxDPs[_id].realId);
                }
            }
        } else {
            this.log.debug(
                `subscribing to all data points as we have ${Object.keys(this._influxDPs).length} data points to log`,
            );
            this._subscribeAll = true;
            this.subscribeForeignStates('*');
        }
    }

    private async loadCustomEntitiesAsync(): Promise<void> {
        const doc = await this.getObjectViewAsync('system', 'custom', {});

        if (!doc || !doc.rows || doc.rows.length == 0) {
            return;
        }

        const filteredRows = doc.rows.filter(row => !!row.value).filter(row => row.value[this.namespace]?.enabled);

        for (const row of filteredRows) {
            const item: {
                id: string;
                value: {
                    [key: `${string}.${number}`]: InfluxDbCustomConfigTyped;
                };
            } = row;

            let id = item.id;
            const realId = id;

            if (item.value[this.namespace]?.aliasId) {
                this._aliasMap[id] = item.value[this.namespace].aliasId;
                this.log.debug(`Found Alias: ${id} --> ${this._aliasMap[id]}`);
                id = this._aliasMap[id];
            }

            this._influxDPs[id] = normalizeStateConfig(
                item.value[this.namespace],
                this.config,
            ) as SavedInfluxDbCustomConfig;

            this._influxDPs[id].config = JSON.stringify(item.value[this.namespace]);
            this.log.debug(`enabled logging of ${id}, Alias=${id !== realId} points now activated`);

            this._influxDPs[id].realId = realId;
            await this.writeInitialValue(realId, id);
        }
    }

    private createMetricInstruments(): void {
        this.log.info(`Creating instruments for ${Object.keys(this._influxDPs).length} data points.`);

        for (const trackedDataPointKey of Object.keys(this._influxDPs)) {
            this.createInstrumentForDataPointKey(trackedDataPointKey);
        }
    }

    private getInstrumentIdentifier(dataPoint: SavedInfluxDbCustomConfig): string {
        const { aliasId, realId } = dataPoint;

        // TBD: Check if this is required.
        return isNullOrUndefined(aliasId) || aliasId.trim() === '' ? realId : aliasId;
    }

    private createInstrumentForDataPointKey(trackedDataPointKey: string): void {
        const trackedDataPoint = this._influxDPs[trackedDataPointKey];
        const instrumentIdentifier = this.getInstrumentIdentifier(trackedDataPoint);

        if (isNullOrUndefined(this._meter)) {
            this.log.error('No meter instance was created. This should never happen.');
            return;
        }

        this.log.debug(`Creating gauge with name: '${instrumentIdentifier}'`);
        this._instrumentLookup[instrumentIdentifier] = this._meter.createGauge(instrumentIdentifier);
    }

    private removeInstrumentForDataPointKey(trackedDataPointKey: string): void {
        const trackedDataPoint = this._influxDPs[trackedDataPointKey];
        const instrumentIdentifier = this.getInstrumentIdentifier(trackedDataPoint);

        if (!Object.prototype.hasOwnProperty.call(this._instrumentLookup, instrumentIdentifier)) {
            this.log.warn(
                `Expected instrument '${instrumentIdentifier}' to be present, but it was not. Skipping removal.`,
            );
            return;
        }

        delete this._instrumentLookup[instrumentIdentifier];
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            this.log.info('Shutting down open telemetry SDK.');

            if (!isNullOrUndefined(this._meterProvider)) {
                await this._meterProvider.forceFlush();
                await this._meterProvider.shutdown();
            }
        } finally {
            callback();
        }
    }

    private isTrackedDataPoint(object: unknown): object is InfluxDbCustomConfig {
        if (object === null || object === undefined) {
            return false;
        }

        return (
            Object.prototype.hasOwnProperty.call(object, 'aliasId') &&
            Object.prototype.hasOwnProperty.call(object, 'enabled')
        );
    }

    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        const formerAliasId = this._aliasMap[id] ? this._aliasMap[id] : id;

        if (isNullOrUndefined(obj?.common?.custom?.[this.namespace])) {
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

    private addTrackedAlias(id: string, customConfig: InfluxDbCustomConfig, formerAliasId: string): void {
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
                customConfig.aliasId = '';
            }
        }

        if (checkForRemove && this._aliasMap[id]) {
            this.log.debug(`Removed Alias: ${id} !-> ${this._aliasMap[id]}`);
            delete this._aliasMap[id];
        }

        // if not yet subscribed
        if (!this._influxDPs[formerAliasId] && !this._subscribeAll) {
            if (Object.keys(this._influxDPs).length >= 19) {
                // unsubscribe all subscriptions and subscribe to all
                for (const _id in this._influxDPs) {
                    this.unsubscribeForeignStates(this._influxDPs[_id].realId);
                }
                this._subscribeAll = true;
                this.subscribeForeignStates('*');
            } else {
                this.subscribeForeignStates(realId);
            }
        }

        const customSettings: InfluxDbCustomConfig = normalizeStateConfig(customConfig, this.config);

        if (
            this._influxDPs[formerAliasId] &&
            !this._influxDPs[formerAliasId].storageTypeAdjustedInternally &&
            JSON.stringify(customSettings) === this._influxDPs[formerAliasId].config
        ) {
            this.log.debug(`Object ${id} unchanged. Ignore`);
            return;
        }

        // relogTimeout
        if (this._influxDPs[formerAliasId] && this._influxDPs[formerAliasId].relogTimeout) {
            clearTimeout(this._influxDPs[formerAliasId].relogTimeout);
            this._influxDPs[formerAliasId].relogTimeout = null;
        }

        const state = this._influxDPs[formerAliasId] ? this._influxDPs[formerAliasId].state : null;
        const skipped = this._influxDPs[formerAliasId] ? this._influxDPs[formerAliasId].skipped : null;
        const timeout = this._influxDPs[formerAliasId] ? this._influxDPs[formerAliasId].timeout : null;

        this._influxDPs[id] = customSettings as SavedInfluxDbCustomConfig;
        this._influxDPs[id].config = JSON.stringify(customSettings);
        this._influxDPs[id].realId = realId;
        this._influxDPs[id].state = state;
        this._influxDPs[id].skipped = skipped;
        this._influxDPs[id].timeout = timeout;

        void this.writeInitialValue(realId, id);

        this.log.info(`enabled logging of ${id}, Alias=${id !== realId}`);
    }

    private removeTrackedAlias(id: string, formerAliasId: string): void {
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

    async writeInitialValue(realId: string, id: string): Promise<void> {
        const state = await this.getForeignStateAsync(realId);

        if (!state || !this._influxDPs[id]) {
            return;
        }

        state.from = `system.adapter.${this.namespace}`;
        this._influxDPs[id].state = state;

        this.log.debug('writeInitialValue called');
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
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

        this._meterProvider?.forceFlush();
    }

    private transformStateValue(instrument: Gauge, iobValue: ioBroker.StateValue): number | null {
        return parseNumberWithNull(iobValue);
    }

    private onMessage(msg: ioBroker.Message): void {
        this.log.debug(`Incoming message ${msg.command} from ${msg.from}`);
        this.log.info(JSON.stringify(msg));
    }
}
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Otlp(options);
} else {
    // otherwise start the instance directly
    (() => new Otlp())();
}
