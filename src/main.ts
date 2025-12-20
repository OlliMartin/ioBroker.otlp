/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from '@iobroker/adapter-core';
import type { InfluxDBAdapterConfig, InfluxDbCustomConfig, InfluxDbCustomConfigTyped } from './types';

// Load your modules here, e.g.:
// import * as fs from 'fs';

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

    // Mapping from AliasID to ioBroker ID
    private readonly _influxDPs: {
        [ioBrokerId: string]: SavedInfluxDbCustomConfig;
    } = {};

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
        this.log.info('Adapter is ready.');

        const doc = await this.getObjectViewAsync('system', 'custom', {});

        if (doc?.rows) {
            const l = doc.rows.length;
            for (let i = 0; i < l; i++) {
                if (doc.rows[i].value) {
                    const item: {
                        id: string;
                        value: {
                            [key: `${string}.${number}`]: InfluxDbCustomConfigTyped;
                        };
                    } = doc.rows[i];
                    let id = item.id;
                    const realId = id;
                    if (!item.value[this.namespace]?.enabled) {
                        this.log.debug("Skipping data point. It's not enabled.");
                        continue;
                    }
                    if (item.value[this.namespace]?.aliasId) {
                        this._aliasMap[id] = item.value[this.namespace].aliasId;
                        this.log.debug(`Found Alias: ${id} --> ${this._aliasMap[id]}`);
                        id = this._aliasMap[id];
                    }
                    this._influxDPs[id] = this.normalizeStateConfig(
                        item.value[this.namespace],
                        this.config,
                    ) as SavedInfluxDbCustomConfig;
                    this._influxDPs[id].config = JSON.stringify(item.value[this.namespace]);
                    this.log.debug(`enabled logging of ${id}, Alias=${id !== realId} points now activated`);

                    this._influxDPs[id].realId = realId;
                    await this.writeInitialValue(realId, id);
                }
            }
        }

        // If we have less than 20 datapoints, subscribe individually, else subscribe to all
        if (Object.keys(this._influxDPs).length < 20) {
            this.log.info(`subscribing to ${Object.keys(this._influxDPs).length} datapoints`);
            for (const _id in this._influxDPs) {
                if (Object.prototype.hasOwnProperty.call(this._influxDPs, _id)) {
                    this.subscribeForeignStates(this._influxDPs[_id].realId);
                }
            }
        } else {
            this.log.debug(
                `subscribing to all datapoints as we have ${Object.keys(this._influxDPs).length} datapoints to log`,
            );
            this._subscribeAll = true;
            this.subscribeForeignStates('*');
        }

        this.subscribeForeignObjects('*');
    }

    private onUnload(callback: () => void): void {
        try {
            this.log.info('Shutting down adapter.');
        } finally {
            callback();
        }
    }

    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        this.log.info(`OMA Received object change for id ${id}`);

        const formerAliasId = this._aliasMap[id] ? this._aliasMap[id] : id;
        if (
            obj?.common?.custom?.[this.namespace] &&
            typeof obj.common.custom[this.namespace] === 'object' &&
            obj.common.custom[this.namespace].enabled
        ) {
            const realId = id;
            let checkForRemove = true;
            if (obj.common.custom?.[this.namespace]?.aliasId) {
                if (obj.common.custom[this.namespace].aliasId !== id) {
                    this._aliasMap[id] = obj.common.custom[this.namespace].aliasId;
                    this.log.debug(`Registered Alias: ${id} --> ${this._aliasMap[id]}`);
                    id = this._aliasMap[id];
                    checkForRemove = false;
                } else {
                    this.log.warn(`Ignoring Alias-ID because identical to ID for ${id}`);
                    obj.common.custom[this.namespace].aliasId = '';
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

            const customSettings: InfluxDbCustomConfig = this.normalizeStateConfig(
                obj.common.custom[this.namespace],
                this.config,
            );

            if (
                this._influxDPs[formerAliasId] &&
                !this._influxDPs[formerAliasId].storageTypeAdjustedInternally &&
                JSON.stringify(customSettings) === this._influxDPs[formerAliasId].config
            ) {
                if (customSettings.enableDebugLogs) {
                    this.log.debug(`Object ${id} unchanged. Ignore`);
                }
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
        } else {
            if (this._aliasMap[id]) {
                this.log.debug(`Removed Alias: ${id} !-> ${this._aliasMap[id]}`);
                delete this._aliasMap[id];
            }

            id = formerAliasId;

            if (this._influxDPs[id]) {
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
        }
    }

    async writeInitialValue(realId: string, id: string): Promise<void> {
        const state = await this.getForeignStateAsync(realId);
        if (state && this._influxDPs[id]) {
            state.from = `system.adapter.${this.namespace}`;
            this._influxDPs[id].state = state;

            this.log.debug('writeInitialValue called');

            // if (this.config.relogLastValueOnStart) {
            //     this._tasksStart.push(id);
            //     if (this._tasksStart.length === 1 && this._connected) {
            //         await this.processStartValues();
            //     }
            // }
        }
    }

    normalizeStateConfig(
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

        customConfig.debounceTime = this.parseNumber(customConfig.debounceTime, 0);
        customConfig.changesOnly = this.parseBool(customConfig.changesOnly);
        customConfig.ignoreZero = this.parseBool(customConfig.ignoreZero);

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

        customConfig.ignoreAboveNumber = this.parseNumberWithNull(customConfig.ignoreAboveNumber);
        customConfig.ignoreBelowNumber = this.parseNumberWithNull(customConfig.ignoreBelowNumber);
        if (customConfig.ignoreBelowNumber === null && this.parseBool(customConfig.ignoreBelowZero)) {
            customConfig.ignoreBelowNumber = 0;
        }

        customConfig.disableSkippedValueLogging = this.parseBool(
            customConfig.disableSkippedValueLogging,
            defaultConfig.disableSkippedValueLogging,
        );
        customConfig.enableDebugLogs = this.parseBool(customConfig.enableDebugLogs, defaultConfig.enableDebugLogs);
        customConfig.changesRelogInterval = this.parseNumber(
            customConfig.changesRelogInterval,
            defaultConfig.changesRelogInterval as number,
        );
        customConfig.changesMinDelta = this.parseNumber(customConfig.changesMinDelta, defaultConfig.changesMinDelta);

        customConfig.storageType ||= false;
        return customConfig as InfluxDbCustomConfigTyped;
    }

    parseBool(value: any, defaultValue?: boolean): boolean {
        if (value !== undefined && value !== null && value !== '') {
            return value === true || value === 'true' || value === 1 || value === '1';
        }
        return defaultValue || false;
    }

    parseNumber(value: any, defaultValue?: number): number {
        if (typeof value === 'number') {
            return value;
        }
        if (typeof value === 'string') {
            const v = parseFloat(value);
            return isNaN(v) ? defaultValue || 0 : v;
        }
        return defaultValue || 0;
    }

    parseNumberWithNull(value: any): number | null {
        if (typeof value === 'number') {
            return value;
        }
        if (typeof value === 'string') {
            const v = parseFloat(value);
            return isNaN(v) ? null : v;
        }
        return null;
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param id - State ID
     * @param state - State object
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

            if (state.ack === false) {
                // This is a command from the user (e.g., from the UI or other adapter)
                // and should be processed by the adapter
                this.log.info(`User command received for ${id}: ${state.val}`);

                // TODO: Add your control logic here
            }
        } else {
            // The object was deleted or the state value has expired
            this.log.info(`state ${id} deleted`);
        }
    }

    private onMessage(msg: ioBroker.Message): void {
        this.log.debug(`Incoming message ${msg.command} from ${msg.from}`);
        this.log.info('OMA Received message.');
        this.log.warn(JSON.stringify(msg));
    }
}
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Otlp(options);
} else {
    // otherwise start the instance directly
    (() => new Otlp())();
}
