/* eslint-disable jsdoc/no-blank-blocks */

/**
 *
 */
export interface OtlpCustomConfig {
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
export interface OtlpAdapterConfig {
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
    meterName: string;
    /**
     *
     */
    headers: { key: string; value: string }[];
    /**
     *
     */
    resourceAttributes: { key: string; value: string }[];
}

/**
 *
 */
export interface OtlpCustomConfigTyped {
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
