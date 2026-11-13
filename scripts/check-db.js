const db = require('better-sqlite3')('dwi.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));
const cols = db.pragma('table_info(audit_log)');
console.log('Audit columns:', cols.map(c => c.name).join(', '));
const count = db.prepare('SELECT COUNT(*) as c FROM audit_log').get();
console.log('Audit entries:', count.c);
if (count.c > 0) {
    const latest = db.prepare('SELECT seq, trace_id, agent_name, policy_decision FROM audit_log ORDER BY seq DESC LIMIT 3').all();
    console.log(JSON.stringify(latest, null, 2));
}
