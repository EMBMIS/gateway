/**
 * SAG CLI — `sag compile`
 * 
 * Wraps policy-compiler.js into a clean operational interface.
 * Enforces monotonic versioning before calling KMS.
 */
const fs = require('fs');
const { execSync } = require('child_process');
const config = require('../lib/config');
const redisClient = require('../lib/redis-client');

async function compileCommand(options) {
    let targetVersion = parseInt(options.bundleVersion, 10);

    // --auto mode: fetch current watermark and auto-increment
    if (options.auto) {
        let diskWatermark = 0;
        try {
            const wm = JSON.parse(fs.readFileSync(config.watermarkPath, 'utf8'));
            diskWatermark = wm.highest_version || 0;
        } catch { }

        const redisWatermark = await redisClient.getRedisWatermark();
        const effective = Math.max(redisWatermark || 0, diskWatermark);
        targetVersion = effective + 1;
        console.log(`\n  [auto] Current watermark: v${effective}`);
        console.log(`  [auto] Compiling version: v${targetVersion}\n`);
        await redisClient.close();
    }

    if (!targetVersion || isNaN(targetVersion) || targetVersion < 1) {
        console.error('\n  Error: --version <number> is required (or use --auto).\n');
        process.exit(1);
    }

    // Pre-flight: verify monotonic increment
    let diskWatermark = 0;
    try {
        const wm = JSON.parse(fs.readFileSync(config.watermarkPath, 'utf8'));
        diskWatermark = wm.highest_version || 0;
    } catch { }

    if (targetVersion < diskWatermark) {
        console.error(`\n  ✖ REJECTED: Version v${targetVersion} is below disk watermark v${diskWatermark}.`);
        console.error(`  This would trigger a DOWNGRADE ATTACK detection on the Worker.\n`);
        process.exit(1);
    }

    if (options.dryRun) {
        console.log(`  [dry-run] Would compile policy bundle v${targetVersion}`);
        console.log(`  [dry-run] KMS Key: ${process.env.KMS_KEY_ID || process.env.SAG_POLICY_KEY_ID || 'alias/policy-authority-dev'}`);
        console.log(`  [dry-run] Output: ${config.bundlePath}`);
        console.log(`  [dry-run] No changes made.\n`);
        return;
    }

    // Execute the actual compiler
    console.log(`  Compiling policy bundle v${targetVersion}...\n`);
    try {
        const output = execSync(
            `node src/policy-compiler.js`,
            {
                cwd: config.projectRoot,
                encoding: 'utf8',
                env: { ...process.env, BUNDLE_VERSION: String(targetVersion) },
                stdio: 'pipe'
            }
        );
        console.log(output);
    } catch (err) {
        console.error(`  ✖ Compilation failed:\n  ${err.stderr || err.message}\n`);
        process.exit(1);
    }

    // Read the generated artifact and display summary
    try {
        const artifact = JSON.parse(fs.readFileSync(config.bundlePath, 'utf8'));
        const hash = artifact.metadata?.policy_bundle_hash || 'unknown';
        const sig = artifact.signature?.substring(0, 16) || 'unknown';

        console.log(`  ────────────────────────────────────────`);
        console.log(`  ✔ Bundle Compiled Successfully`);
        console.log(`  Version:     v${artifact.bundle?.version}`);
        console.log(`  Hash:        ${hash.substring(0, 16)}...`);
        console.log(`  Signature:   ${sig}...`);
        console.log(`  Key ID:      ${artifact.key_id}`);
        console.log(`  Output:      ${config.bundlePath}`);
        console.log(`  ────────────────────────────────────────\n`);
    } catch {
        console.log('  Bundle written but could not read summary.\n');
    }

    await redisClient.close();
}

module.exports = compileCommand;
