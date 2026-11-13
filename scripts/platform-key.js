#!/usr/bin/env node
/**
 * npm run platform-key — create a platform key for a platform such as EMBMIS Business OS.
 *
 * Prints the key once (give it to the platform as EMBMIS_GATEWAY_PLATFORM_KEY) and the line to add to the
 * gateway's environment. The gateway stores only the SHA-256 hash.
 */
const crypto = require('crypto');
const key = 'sag_platform_' + crypto.randomBytes(32).toString('hex');
const hash = crypto.createHash('sha256').update(key).digest('hex');
console.log('\nPlatform key (shown once — give it to the platform):\n');
console.log(`  ${key}\n`);
console.log('Add this hash to the gateway environment (comma-separate several to rotate):\n');
console.log(`  SAG_PLATFORM_KEY_HASHES=${hash}\n`);
