/**
 * SAG CLI — Redis Client Abstraction
 * 
 * Provides read-only access to the distributed watermark state.
 * Used by `sag watermark` and `sag status`.
 */
const { createClient } = require('redis');
const config = require('./config');

let client = null;

async function getClient() {
    if (!client) {
        client = createClient({
            url: config.redisUrl,
            socket: { connectTimeout: 2000, reconnectStrategy: false }
        });
        client.on('error', () => { }); // Suppress background errors
        // Hard timeout so CLI never hangs
        await Promise.race([
            client.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connect timeout')), 3000))
        ]);
    }
    return client;
}

/**
 * Get the distributed watermark version from Redis.
 * Returns integer or 0 if not set.
 */
async function getRedisWatermark() {
    try {
        const c = await getClient();
        const val = await c.get('watermark:bundle_version');
        return val ? parseInt(val, 10) : 0;
    } catch {
        return null; // Redis unreachable
    }
}

/**
 * Check if Redis is alive and reachable.
 */
async function ping() {
    try {
        const c = await getClient();
        const result = await c.ping();
        return result === 'PONG';
    } catch {
        return false;
    }
}

async function close() {
    if (client) {
        await client.quit().catch(() => { });
        client = null;
    }
}

module.exports = { getRedisWatermark, ping, close };
