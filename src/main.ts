/*
 * Created with @iobroker/create-adapter v3.1.2
 */

import type { Gauge, Meter as IMeter } from '@opentelemetry/api';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { OTLPMetricExporterOptions } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPHttpExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPGrpcExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { resourceFromAttributes, emptyResource } from '@opentelemetry/resources';

import * as utils from '@iobroker/adapter-core';
import type { InfluxDBAdapterConfig, InfluxDbCustomConfig, InfluxDbCustomConfigTyped } from './types';

function isNullOrUndefined(obj?: any): obj is null {
    return obj === undefined || obj === null;
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

function transformAttributes(
    attributesFromConfig: { key: string; value: string }[] | undefined,
): Record<string, string> {
    if (!attributesFromConfig) {
        return {};
    }

    return attributesFromConfig.reduce((prev, tuple) => ({ ...prev, [tuple.key]: tuple.value }), {});
}

interface SavedInfluxDbCustomConfig extends InfluxDbCustomConfigTyped {
    config: string;
    realId: string;
    state: ioBroker.State | null | undefined;
    skipped: ioBroker.State | null | undefined;
    lastLogTime?: number;
}

class Otlp extends utils.Adapter {
    declare config: InfluxDBAdapterConfig;

    // mapping from ioBroker ID to Alias ID
    private readonly _aliasMap: { [ioBrokerId: string]: string } = {};
    private _subscribeAll = false;

    private _meterProvider: MeterProvider | null = null;
    private _meter: IMeter | null = null;

    private _connected: boolean = false;

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
        this.setConnected(false);

        const { protocol, otlProtocol, host, port } = this.config;

        if (
            isNullOrUndefined(protocol) ||
            isNullOrUndefined(otlProtocol) ||
            isNullOrUndefined(host) ||
            isNullOrUndefined(port)
        ) {
            this.log.error(
                'At least one required property was not set. Cannot start. Please adjust the configuration.',
            );
            return;
        }

        const { headers, resourceAttributes } = this.config;

        let otlpEndpoint: string | null = null;
        let metricExporter: PushMetricExporter | null = null;

        if (otlProtocol === 'http') {
            otlpEndpoint = `${protocol}://${host}:${port}/v1/metrics`;

            const collectorOptions: OTLPMetricExporterOptions = {
                url: otlpEndpoint,
                headers,
            };
            metricExporter = new OTLPHttpExporter(collectorOptions);
        }

        if (otlProtocol === 'grpc') {
            otlpEndpoint = `${protocol}://${host}:${port}/otlp`;

            const collectorOptions: OTLPMetricExporterOptions = {
                url: otlpEndpoint,
                headers,
            };
            metricExporter = new OTLPGrpcExporter(collectorOptions);
        }

        if (!otlpEndpoint || !metricExporter) {
            this.log.error('Could not create metric exporter. Cannot continue. Stopping.');
            return;
        }

        this.log.info(`Connecting to OTLP endpoint: ${otlpEndpoint}`);

        const resource =
            !!resourceAttributes && Object.keys(resourceAttributes).length > 0
                ? resourceFromAttributes(transformAttributes(resourceAttributes))
                : emptyResource();

        this._meterProvider = new MeterProvider({
            readers: [
                new PeriodicExportingMetricReader({
                    exporter: metricExporter,
                    exportIntervalMillis: 1000,
                }),
            ],
            resource,
        });

        // TODO: Allow providing meter name from adapter config.
        this._meter = this._meterProvider.getMeter('ioBroker.otlp', undefined, {});
        this.setConnected(true);

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

            this._influxDPs[id] = item.value[this.namespace] as SavedInfluxDbCustomConfig;

            this._influxDPs[id].config = JSON.stringify(item.value[this.namespace]);
            this.log.debug(`enabled logging of ${id}, Alias=${id !== realId} points now activated`);

            this._influxDPs[id].realId = realId;
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
        return isNullOrUndefined(aliasId) || aliasId.trim() === '' ? realId : aliasId;
    }

    private createInstrumentForDataPointKey(trackedDataPointKey: string): void {
        if (!Object.prototype.hasOwnProperty.call(this._influxDPs, trackedDataPointKey)) {
            this.log.warn(
                `Expected instrument '${trackedDataPointKey}' to be present in data points, but it was not. Skipping.`,
            );
            return;
        }

        const trackedDataPoint = this._influxDPs[trackedDataPointKey];
        const instrumentIdentifier = this.getInstrumentIdentifier(trackedDataPoint);

        if (isNullOrUndefined(this._meter)) {
            this.log.error('No meter instance was created. This should never happen.');
            return;
        }

        this.log.debug(`Creating gauge with name: '${instrumentIdentifier}' (key=${trackedDataPointKey})`);
        this._instrumentLookup[trackedDataPointKey] = this._meter.createGauge(instrumentIdentifier);
    }

    private removeInstrumentForDataPointKey(trackedDataPointKey: string): void {
        if (!Object.prototype.hasOwnProperty.call(this._instrumentLookup, trackedDataPointKey)) {
            this.log.warn(
                `Expected instrument '${trackedDataPointKey}' to be present, but it was not. Skipping removal.`,
            );
            return;
        }

        this.log.debug(`Removing instrument with id: '${trackedDataPointKey}'.`);
        delete this._instrumentLookup[trackedDataPointKey];
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
            void this.writeInitialValue(id);
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

        const customSettings: InfluxDbCustomConfig = customConfig;

        const state = this._influxDPs[formerAliasId] ? this._influxDPs[formerAliasId].state : null;
        const skipped = this._influxDPs[formerAliasId] ? this._influxDPs[formerAliasId].skipped : null;

        this._influxDPs[id] = customSettings as SavedInfluxDbCustomConfig;
        this._influxDPs[id].config = JSON.stringify(customSettings);
        this._influxDPs[id].realId = realId;
        this._influxDPs[id].state = state;
        this._influxDPs[id].skipped = skipped;

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

        delete this._influxDPs[id];
        this.log.info(`disabled logging of ${id}`);

        if (!this._subscribeAll) {
            this.unsubscribeForeignStates(id);
        }
    }

    async writeInitialValue(id: string): Promise<void> {
        const state = await this.getForeignStateAsync(id);

        if (!state || !this._influxDPs[id]) {
            return;
        }

        state.from = `system.adapter.${this.namespace}`;
        this._influxDPs[id].state = state;

        this.recordStateByIobId(id, state);
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state) {
            return;
        }

        if (isNullOrUndefined(this._influxDPs[id])) {
            return;
        }

        this.recordStateByIobId(id, state);
    }

    private recordStateByIobId(id: string, state: ioBroker.State): void {
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

        instrument.record(otlpValue, transformAttributes(dataPointCfg?.attributes));
    }

    private transformStateValue(iobValue: ioBroker.StateValue): number | null {
        return parseNumberWithNull(iobValue);
    }

    private onMessage(msg: ioBroker.Message): void {
        this.log.debug(`Incoming message ${msg.command} from ${msg.from}`);
        this.log.info(JSON.stringify(msg));
    }

    private setConnected(isConnected: boolean): void {
        if (this._connected !== isConnected) {
            this._connected = isConnected;
            void this.setState('info.connection', this._connected, true, error =>
                // analyse if the state could be set (because of permissions)
                error
                    ? this.log.error(`Can not update this._connected state: ${error}`)
                    : this.log.debug(`connected set to ${this._connected}`),
            );
        }
    }
}
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Otlp(options);
} else {
    // otherwise start the instance directly
    (() => new Otlp())();
}
