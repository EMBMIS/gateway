/**
 * SAG CLI — `sag trace <trace_id>`
 * 
 * Correlates a trace ID across the Gateway audit ledger.
 * Renders a structured timeline of the request lifecycle.
 * 
 * Backed by LedgerClient abstraction (currently SQLite read-only).
 */
const Table = require('cli-table3');
const ledger = require('../lib/ledger-client');

function traceCommand(traceId, options) {
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(traceId)) {
        console.error(`\n  Error: Invalid trace_id format. Expected UUID.\n  Received: ${traceId}\n`);
        process.exit(1);
    }

    const entry = ledger.getTraceEntry(traceId);
    ledger.close();

    if (!entry) {
        console.error(`\n  Trace not found: ${traceId}\n  The trace may not exist or has not been committed to the ledger yet.\n`);
        process.exit(1);
    }

    if (options.json) {
        console.log(JSON.stringify(entry, null, 2));
        return;
    }

    // Parse stored JSON safely
    let requestPayload = {};
    let responseSummary = {};
    try { requestPayload = JSON.parse(entry.request_payload || '{}'); } catch { }
    try { responseSummary = JSON.parse(entry.response_summary || '{}'); } catch { }

    console.log(`\n  ╔══════════════════════════════════════════════╗`);
    console.log(`  ║  TRACE: ${traceId}  ║`);
    console.log(`  ╚══════════════════════════════════════════════╝\n`);

    const table = new Table({
        colWidths: [22, 48],
        style: { head: ['cyan'] }
    });

    table.push(
        [{ colSpan: 2, content: '── Gateway ──', hAlign: 'center' }],
        ['Agent', entry.agent_name],
        ['Tool', entry.tool],
        ['Action', entry.action],
        ['Risk Score', `${entry.risk_score}/100`],
        ['Decision', entry.policy_decision.toUpperCase()],
        ['Matched Policy', entry.matched_policy_name || 'N/A'],
        ['Timestamp', entry.timestamp],
        ['Latency', `${parseFloat(entry.latency_ms || 0).toFixed(2)}ms`],
        [{ colSpan: 2, content: '── Integrity ──', hAlign: 'center' }],
        ['Request Hash', entry.request_hash?.substring(0, 32) + '...'],
        ['Result Hash', entry.result_hash ? entry.result_hash.substring(0, 32) + '...' : 'N/A'],
        ['Prev Chain Hash', entry.prev_hash?.substring(0, 32) + '...'],
        ['Enclave Attestation', entry.enclave_attestation || 'N/A']
    );

    if (entry.policy_decision === 'allow' && Object.keys(responseSummary).length > 0) {
        table.push(
            [{ colSpan: 2, content: '── Execution Result ──', hAlign: 'center' }],
            ['Result', JSON.stringify(responseSummary).substring(0, 46)]
        );
    }

    console.log(table.toString());
    console.log();
}

module.exports = traceCommand;
