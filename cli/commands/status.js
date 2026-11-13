/**
 * SAG CLI — `sag status`
 * 
 * Polls Gateway and Worker health, displays active bundle,
 * watermark state, Redis connectivity, and mTLS enforcement.
 */
const fs = require('fs');
const Table = require('cli-table3');
const config = require('../lib/config');
const redisClient = require('../lib/redis-client');

async function statusCommand(options) {
    const results = {};

    // 1. Gateway Health
    try {
        const res = await fetch(`${config.gatewayUrl}/api/health`);
        if (res.ok) {
            const data = await res.json();
            results.gateway = { status: 'Healthy', data };
        } else {
            results.gateway = { status: `Unhealthy (HTTP ${res.status})` };
        }
    } catch {
        results.gateway = { status: 'Unreachable' };
    }

    // 2. Active Bundle
    let bundleVersion = 'N/A';
    let bundleHash = 'N/A';
    let keyId = 'N/A';
    try {
        const bundle = JSON.parse(fs.readFileSync(config.bundlePath, 'utf8'));
        bundleVersion = `v${bundle.bundle?.version || '?'}`;
        bundleHash = bundle.metadata?.policy_bundle_hash?.substring(0, 16) || 'N/A';
        keyId = bundle.key_id || 'N/A';
    } catch {
        bundleVersion = 'MISSING';
    }

    // 3. Redis
    const redisAlive = await redisClient.ping();
    const redisWatermark = await redisClient.getRedisWatermark();

    // 4. Disk Watermark
    let diskWatermark = 0;
    try {
        const wm = JSON.parse(fs.readFileSync(config.watermarkPath, 'utf8'));
        diskWatermark = wm.highest_version || 0;
    } catch { /* no watermark file yet */ }

    const effectiveWatermark = Math.max(redisWatermark || 0, diskWatermark);

    // 5. mTLS
    const mtlsCerts = fs.existsSync(config.certsDir + '/ca-cert.pem') &&
        fs.existsSync(config.certsDir + '/server-cert.pem');

    // 6. CRL
    let crlEntries = 0;
    try {
        const crl = JSON.parse(fs.readFileSync(config.crlPath, 'utf8'));
        crlEntries = crl.revoked_keys?.length || 0;
    } catch { /* no CRL */ }

    if (options.json) {
        console.log(JSON.stringify({
            gateway: results.gateway.status,
            bundle: { version: bundleVersion, hash: bundleHash, keyId },
            watermark: { redis: redisWatermark, disk: diskWatermark, effective: effectiveWatermark },
            redis: redisAlive ? 'Connected' : 'Unreachable',
            mtls: mtlsCerts ? 'Configured' : 'Missing',
            crl: { entries: crlEntries }
        }, null, 2));
    } else {
        const table = new Table({
            head: ['Component', 'Status'],
            colWidths: [28, 42],
            style: { head: ['cyan'] }
        });

        table.push(
            ['Gateway', results.gateway.status],
            ['Bundle Version', bundleVersion],
            ['Bundle Hash', bundleHash + '...'],
            ['Signing Key', keyId],
            ['Redis', redisAlive ? '● Connected' : '✖ Unreachable'],
            ['Redis Watermark', redisWatermark !== null ? `v${redisWatermark}` : 'N/A'],
            ['Disk Watermark', `v${diskWatermark}`],
            ['Effective Watermark', `v${effectiveWatermark}`],
            ['mTLS Certificates', mtlsCerts ? '● Present' : '✖ Missing'],
            ['Revoked Keys (CRL)', `${crlEntries} entries`]
        );

        console.log('\n  EMBMIS Gateway — Cluster Status\n');
        console.log(table.toString());
        console.log();
    }

    await redisClient.close();
}

module.exports = statusCommand;
