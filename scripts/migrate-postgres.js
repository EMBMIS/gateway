#!/usr/bin/env node
'use strict';

/**
 * Run once to initialize the PostgreSQL schema.
 * Safe to re-run — all statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   DATABASE_URL=postgres://admin:pass@localhost:5432/sag_db node scripts/migrate-postgres.js
 *   docker compose up -d postgres && node scripts/migrate-postgres.js
 */

const { connect } = require('../src/database-pg');

async function main() {
    console.log('[migrate] Connecting to PostgreSQL...');
    try {
        await connect();
        console.log('[migrate] Schema migration complete.');
        process.exit(0);
    } catch (err) {
        console.error('[migrate] Failed:', err.message);
        process.exit(1);
    }
}

main();
