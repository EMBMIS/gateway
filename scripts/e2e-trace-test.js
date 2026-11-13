// Full E2E: get trace_id from container, then run sag trace
const { execSync } = require('child_process');

// Step 1: Get trace_id from container DB
console.log('--- Step 1: Extracting trace_id from Gateway container ---');
const tid = execSync(
    'docker exec dwi-gateway node -e "const db=require(\'better-sqlite3\')(\'dwi.db\',{readonly:true}); process.stdout.write(db.prepare(\'SELECT trace_id FROM audit_log WHERE trace_id IS NOT NULL ORDER BY seq DESC LIMIT 1\').get().trace_id)"',
    { encoding: 'utf8' }
).trim();
console.log('Trace ID:', tid);

// Step 2: Run sag trace
console.log('\n--- Step 2: sag trace ---');
try {
    const out = execSync(`node cli/bin/sag.js trace ${tid}`, { encoding: 'utf8' });
    console.log(out);
} catch (err) {
    console.log('STDOUT:', err.stdout);
    console.log('STDERR:', err.stderr);
}

// Step 3: sag watermark
console.log('\n--- Step 3: sag watermark ---');
try {
    const out = execSync('node cli/bin/sag.js watermark', { encoding: 'utf8' });
    console.log(out);
} catch (err) {
    console.log('STDOUT:', err.stdout);
    console.log('STDERR:', err.stderr);
}
