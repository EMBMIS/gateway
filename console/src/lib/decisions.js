// How a decision looks, everywhere. Colour here is state, never decoration.
export const DECISION = {
  allow: { tone: 'ok', glyph: 'check', label: 'Allowed' },
  deny: { tone: 'risk', glyph: 'cross', label: 'Blocked' },
  escalate: { tone: 'warn', glyph: 'clock', label: 'Sent to a person' },
  resolved_approved: { tone: 'ok', glyph: 'check', label: 'Approved by a person' },
  resolved_rejected: { tone: 'risk', glyph: 'cross', label: 'Rejected by a person' },
}

export function decisionOf(row) {
  // The audit log stores policy_decision; legacy execute-path rows use the same words.
  return DECISION[row.policy_decision || row.decision] || { tone: 'ink', label: row.policy_decision || row.decision || 'Unknown' }
}

export const CODE_TEXT = {
  ALLOWED: 'Allowed',
  POLICY_DENY: 'Blocked by a policy',
  BUNDLE_POLICY_DENY: 'Blocked by the signed policy bundle',
  RISK_AUTO_BLOCK: 'Blocked: risk score too high',
  FINANCIAL_THRESHOLD_EXCEEDED: 'Blocked: above the financial limit',
  PLAN_LIMIT_EXCEEDED: 'Blocked: plan limit reached',
  AGENT_SUSPENDED: 'Blocked: agent suspended',
  AGENT_REVOKED: 'Blocked: agent revoked',
  POLICY_ESCALATE: 'A policy sends this to a person',
  RISK_ESCALATION: 'Risk score needs a person',
}

export const safeJson = (value, fallback = null) => {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

/** The explanation the pipeline stored with a decision, or what can be rebuilt from the row. */
export function explanationOf(row) {
  const summary = safeJson(row.response_summary, {})
  if (summary.explanation) return summary.explanation
  return {
    decision: row.policy_decision,
    code: null,
    reason: summary.reason || (summary.blocked ? 'Blocked' : summary.escalated ? 'Sent to a person' : null),
    matchedPolicy: row.matched_policy_name ? { id: row.matched_policy_id, name: row.matched_policy_name } : null,
    riskScore: row.risk_score,
    riskFactors: [],
    intent: null,
    policyBundleHash: null,
  }
}
