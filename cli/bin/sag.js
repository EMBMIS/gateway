#!/usr/bin/env node
/**
 * EMBMIS Gateway CLI (command: sag)
 * v1.0.0 — Operator Workspace
 * 
 * The deterministic control surface for the enforcement fabric.
 * 
 * Usage:
 *   sag status              Show cluster health, bundle, and watermark state
 *   sag trace <trace_id>    Reconstruct a request lifecycle from the audit ledger
 *   sag compile             Compile a new policy bundle via KMS
 *   sag revoke <key_id>     Add a signing key to the revocation list
 *   sag watermark           Display monotonic version watermark state
 */
const { Command } = require('commander');
const program = new Command();

program
    .name('sag')
    .description('EMBMIS Gateway — Operator CLI')
    .version('1.0.0');

// ─── sag status ───
program
    .command('status')
    .description('Display cluster health, active bundle, watermark, and connectivity')
    .option('--json', 'Output as JSON for CI/CD automation')
    .action(async (options) => {
        const statusCommand = require('../commands/status');
        await statusCommand(options);
    });

// ─── sag trace <trace_id> ───
program
    .command('trace <trace_id>')
    .description('Reconstruct a request lifecycle from the audit ledger')
    .option('--json', 'Output as JSON')
    .action((traceId, options) => {
        const traceCommand = require('../commands/trace');
        traceCommand(traceId, options);
    });

// ─── sag compile ───
program
    .command('compile')
    .description('Compile a new KMS-signed policy bundle')
    .option('-b, --bundle-version <number>', 'Target bundle version (monotonic)')
    .option('--auto', 'Auto-increment from current watermark')
    .option('--dry-run', 'Preview compilation without writing')
    .action(async (options) => {
        const compileCommand = require('../commands/compile');
        await compileCommand(options);
    });

// ─── sag revoke <key_id> ───
program
    .command('revoke <key_id>')
    .description('Add a signing key to the revocation list (CRL)')
    .option('--force', 'Skip confirmation prompt')
    .action(async (keyId, options) => {
        const revokeCommand = require('../commands/revoke');
        await revokeCommand(keyId, options);
    });

// ─── sag watermark ───
program
    .command('watermark')
    .description('Display monotonic version watermark state (Redis + Disk)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
        const watermarkCommand = require('../commands/watermark');
        await watermarkCommand(options);
    });

// ─── sag audit <action> ───
program
    .command('audit <action>')
    .description('Manage and verify the audit ledger (actions: verify)')
    .option('--json', 'Output as JSON')
    .action(async (action, options) => {
        if (action === 'verify') {
            const auditCommand = require('../commands/audit');
            await auditCommand(options);
        } else {
            console.error(`Unknown audit action: ${action}`);
            process.exit(1);
        }
    });

program.parse(process.argv);
