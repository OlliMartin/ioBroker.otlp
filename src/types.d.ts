/* eslint-disable jsdoc/no-blank-blocks */

/**
 *
 */
export interface InfluxDbCustomConfig {
    /**
     *
     */
    enabled: boolean | undefined;

    /**
     *
     */
    debounceTime: number | string;
    /**
     *
     */
    blockTime: number | string;
    /**
     *
     */
    changesOnly: boolean | 'true' | 'false';
    /**
     *
     */
    changesRelogInterval: number | string;
    /**
     *
     */
    changesMinDelta: number | string;
    /**
     *
     */
    ignoreBelowNumber: number | string | null | undefined;
    /**
     *
     */
    ignoreAboveNumber: number | string | null;
    /**
     *
     */
    ignoreZero: boolean | 'true' | 'false';
    /**
     *
     */
    disableSkippedValueLogging: boolean | 'true' | 'false' | '';
    /**
     *
     */
    storageType: '' | 'Number' | 'String' | 'Boolean' | false;
    /**
     *
     */
    aliasId: string;
    /**
     *
     */
    round: number | string | null;
    /**
     *
     */
    enableDebugLogs: boolean | 'true' | 'false' | '';
    /**
     *
     */
    debounce: number | string;
    /**
     *
     */
    ignoreBelowZero: boolean | 'true' | 'false';
}

/**
 *
 */
export interface InfluxDBAdapterConfig {
    /**
     *
     */
    debounce: number | string;
    /**
     *
     */
    retention: number | string;
    /**
     *
     */
    dbname: string;
    /**
     *
     */
    host: string;
    /**
     *
     */
    protocol: 'http' | 'https';
    /**
     *
     */
    path: string;
    /**
     *
     */
    port: number | string;
    /**
     *
     */
    user: string;
    /**
     *
     */
    password: string;
    /**
     *
     */
    token: string;
    /**
     *
     */
    organization: string;
    /**
     *
     */
    round: number | string | null;
    /**
     *
     */
    seriesBufferMax: number | string;
    /**
     *
     */
    seriesBufferFlushInterval: number | string;
    /**
     *
     */
    changesRelogInterval: number | string;
    /**
     *
     */
    changesMinDelta: number;
    /**
     *
     */
    reconnectInterval: number | string;
    /**
     *
     */
    pingInterval: number | string;
    /**
     *
     */
    requestTimeout: number | string;
    /**
     *
     */
    validateSSL: boolean;
    /**
     *
     */
    dbversion: '1.x' | '2.x';
    /**
     *
     */
    usetags: boolean;
    /**
     *
     */
    pingserver: boolean;
    /**
     *
     */
    blockTime: number | string;
    /**
     *
     */
    debounceTime: number | string;
    /**
     *
     */
    disableSkippedValueLogging: boolean;
    /**
     *
     */
    enableLogging: boolean;
    /**
     *
     */
    customRetentionDuration: number | string;
    /**
     *
     */
    relogLastValueOnStart: boolean | 'true' | 'false';
    /**
     *
     */
    enableDebugLogs: boolean;
    /**
     *
     */
    limit: number | string;

    /**
     *
     */
    dockerInflux?: {
        /**
         *
         */
        enabled?: boolean;
        /**
         *
         */
        bind?: string;
        /**
         *
         */
        stopIfInstanceStopped?: boolean;
        /**
         *
         */
        port?: number | string;
        /**
         *
         */
        autoImageUpdate?: boolean;
    };
    /**
     *
     */
    dockerGrafana?: {
        /**
         *
         */
        enabled?: boolean;
        /**
         *
         */
        bind?: string;
        /**
         *
         */
        stopIfInstanceStopped?: boolean;
        /**
         *
         */
        port?: number | string;
        /**
         *
         */
        autoImageUpdate?: boolean;
        /**
         *
         */
        adminSecurityPassword?: string;
        /**
         *
         */
        serverRootUrl?: string;
        /**
         *
         */
        plugins?: string[];
        /**
         *
         */
        usersAllowSignUp?: boolean;
    };
}

/**
 *
 */
export interface InfluxDbCustomConfigTyped {
    /**
     *
     */
    enabled: boolean;
    /**
     *
     */
    debounceTime: number;
    /**
     *
     */
    blockTime: number;
    /**
     *
     */
    changesOnly: boolean;
    /**
     *
     */
    changesRelogInterval: number;
    /**
     *
     */
    changesMinDelta: number;
    /**
     *
     */
    ignoreBelowNumber: number | null;
    /**
     *
     */
    ignoreAboveNumber: number | null;
    /**
     *
     */
    ignoreZero: boolean;
    /**
     *
     */
    disableSkippedValueLogging: boolean;
    /**
     *
     */
    storageType: 'Number' | 'String' | 'Boolean' | false;
    /**
     *
     */
    aliasId: string;
    /**
     *
     */
    round: number;
    /**
     *
     */
    enableDebugLogs: boolean;
    /**
     *
     */
    debounce: number;
    /**
     *
     */
    ignoreBelowZero: boolean;
}
