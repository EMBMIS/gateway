/**
 * SAG CLI — `sag watermark`
 * 
 * Displays the current monotonic version watermark state
 * across Redis (distributed) and local disk (durable floor).
 * Highlights mismatches for downgrade observability.
 */
const fs = require('fs');
const Table = require('cli-table3');
const config = require('../lib/config');
const redisClient = require('../lib/redis-client');

async function watermarkCommand(options) {
    // 1. Disk watermark
    let diskWatermark = 0;
    try {
        const wm = JSON.parse(fs.readFileSync(config.watermarkPath, 'utf8'));
        diskWatermark = wm.highest_version || 0;
    } catch { /* no file yet */ }

    // 2. Redis watermark
    const redisWatermark = await redisClient.getRedisWatermark();

    // 3. Active bundle version
    let bundleVersion = null;
    try {
        const bundle = JSON.parse(fs.readFileSync(config.bundlePath, 'utf8'));
        bundleVersion = bundle.bundle?.version || null;
    } catch { /* missing bundle */ }

    const effectiveWatermark = Math.max(redisWatermark || 0, diskWatermark);

    // Detect anomalies
    const redisMismatch = redisWatermark !== null && redisWatermark !== diskWatermark;
    const bundleBehind = bundleVersion !== null && bundleVersion < effectiveWatermark;

    if (options.json) {
        console.log(JSON.stringify({
            redis: redisWatermark,
            disk: diskWatermark,
            effective: effectiveWatermark,
            bundle: bundleVersion,
            anomalies: {
                redis_disk_mismatch: redisMismatch,
                bundle_behind_watermark: bundleBehind
            }
        }, null, 2));
    } else {
        const table = new Table({
            head: ['Source', 'Version', 'Notes'],
            colWidths: [22, 12, 36],
            style: { head: ['cyan'] }
        });

        table.push(
            ['Redis (Cluster)', redisWatermark !== null ? `v${redisWatermark}` : 'Unreachable', redisWatermark === null ? '⚠ Cannot verify cluster state' : ''],
            ['Disk (Local)', `v${diskWatermark}`, ''],
            ['Effective Floor', `v${effectiveWatermark}`, 'MAX(redis, disk)'],
            ['Active Bundle', bundleVersion !== null ? `v${bundleVersion}` : 'N/A', bundleBehind ? '⚠ BEHIND WATERMARK — would crash Worker' : '']
        );

        console.log('\n  EMBMIS Gateway — Watermark State\n');
        console.log(table.toString());

        if (redisMismatch) {
            console.log('\n  ⚠ WARNING: Redis and Disk watermarks are out of sync.');
            console.log('  This may indicate a partial cluster update or Redis reset.');
        }

        if (bundleBehind) {
            console.log('\n  ✖ CRITICAL: Active bundle version is BELOW the effective watermark.');
            console.log('  Deploying this bundle will trigger a DOWNGRADE ATTACK crash.');
        }

        if (!redisMismatch && !bundleBehind) {
            console.log('\n  ✔ Watermark state is consistent.\n');
        } else {
            console.log();
        }
    }

    await redisClient.close();
}

module.exports = watermarkCommand;
