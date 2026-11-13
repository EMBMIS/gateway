#!/usr/bin/env node
/**
 * Print the gateway's schema as PostgreSQL DDL (one statement per line group, ';'-terminated) for an administrator
 * to apply (DEPLOY.md shows how). Touches no database.
 *   node scripts/print-pg-schema.js > schema.sql
 */
const { pgSchemaStatements } = require('../src/database');
process.stdout.write(pgSchemaStatements().map((s) => `${s};`).join('\n') + '\n');
