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
    aliasId: string;
}

/**
 *
 */
export interface InfluxDBAdapterConfig {
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
    otlProtocol: 'grpc' | 'http';
    /**
     *
     */
    port: number | string;
    /**
     *
     */
    headers: Record<string, string>;
    /**
     *
     */
    resourceAttributes: { key: string; value: string }[];
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
    aliasId: string;
    /**
     *
     */
    attributes: { key: string; value: string }[];
}
