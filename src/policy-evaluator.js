/**
 * Shared Authorization Module (v0.3)
 * Evaluates intents against the immutable policy bundle.
 * Used identically by both Gateway (Control Plane) and Worker (Execution Plane).
 */

function evaluateAuthorization(bundle, agentRole, intent) {
    // 1. Check Tool Registry
    if (!bundle.tool_registry[intent.tool]) {
        return {
            allowed: false,
            reason: `Tool '${intent.tool}' is unregistered.`
        };
    }

    // 2. Check Role Permissions
    const rolePerms = bundle.role_permissions[agentRole];
    if (!rolePerms || rolePerms[intent.tool] !== 'allow') {
        return {
            allowed: false,
            reason: `Role '${agentRole}' lacks permission for '${intent.tool}'.`
        };
    }

    // 3. Evaluate Rule-based Policies
    for (const policy of bundle.policies) {
        if (matchesConditions(policy.conditions, intent)) {
            if (policy.effect === 'deny') {
                return {
                    allowed: false,
                    reason: `Blocked by policy '${policy.name}'`
                };
            }
        }
    }

    return { allowed: true };
}

function matchesConditions(conditions, intent) {
    if (!conditions || Object.keys(conditions).length === 0) return false;

    if (conditions.action) {
        const matchTarget = (intent.action) || (intent.args && intent.args.action) || (intent.args && intent.args.sql) || '';
        if (typeof matchTarget === 'string' && matchTarget.toUpperCase().includes(conditions.action.toUpperCase())) {
            return true;
        }
    }

    return false;
}

module.exports = { evaluateAuthorization };
