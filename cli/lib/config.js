/**
 * SAG CLI — Configuration Layer
 * 
 * Centralizes all environment-aware configuration.
 * CLI commands import from here, never read env directly.
 */
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const config = {
    // Paths
    projectRoot: PROJECT_ROOT,
    bundlePath: path.join(PROJECT_ROOT, 'policy.bundle.json'),
    crlPath: process.env.SAG_CRL_PATH ? path.resolve(process.env.SAG_CRL_PATH) : path.join(PROJECT_ROOT, 'revocation_list.json'),
    watermarkPath: process.env.SAG_WATERMARK_PATH ? path.resolve(process.env.SAG_WATERMARK_PATH) : path.join(PROJECT_ROOT, '.worker_watermark.json'),
    certsDir: path.join(PROJECT_ROOT, 'certs'),
    dbPath: path.join(PROJECT_ROOT, 'dwi.db'),

    // Network
    gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:3000',
    workerAddress: process.env.ENCLAVE_ADDRESS || 'localhost:50051',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    kmsUrl: process.env.KMS_URL || 'http://localhost:4000',

    // Security
    mtlsEnabled: process.env.ENABLE_MTLS === 'true',
};

module.exports = config;
