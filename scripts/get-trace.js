const db = require('better-sqlite3')('dwi.db', { readonly: true });
const rows = db.prepare('SELECT trace_id, agent_name, tool, policy_decision FROM audit_log WHERE trace_id IS NOT NULL ORDER BY seq DESC LIMIT 3').all();
rows.forEach(r => console.log(`${r.trace_id}  ${r.agent_name}  ${r.tool}  ${r.policy_decision}`));
