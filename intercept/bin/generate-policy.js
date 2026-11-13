#!/usr/bin/env node
'use strict';

const { generatePolicy } = require('../lib/generate-policy');

const args    = process.argv.slice(2);
const logFile = args.find(a => a.startsWith('--log='))?.split('=')[1]  || process.env.SAG_LOG_FILE || '.sag-observations.jsonl';
const outFile = args.find(a => a.startsWith('--out='))?.split('=')[1]  || 'policy.bundle.json';
const dry     = args.includes('--dry');

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  sag-generate-policy — Auto-generate a SAG policy bundle from learn mode observations

  Usage:
    npx sag-generate-policy [options]

  Options:
    --log=<file>   Observations JSONL file  (default: .sag-observations.jsonl)
    --out=<file>   Output policy bundle     (default: policy.bundle.json)
    --dry          Print to stdout, don't write file
    --help         Show this help

  Workflow:
    1. Run your app with SAG_MODE=learn  →  observations are collected
    2. Run sag-generate-policy           →  policy.bundle.json is created
    3. Review the generated policies
    4. Set SAG_MODE=enforce              →  all AI calls are now gated
`);
    process.exit(0);
}

try {
    generatePolicy({ logFile, outFile, dry });
} catch (err) {
    console.error(`[sag-policy-gen] Error: ${err.message}`);
    process.exit(1);
}
