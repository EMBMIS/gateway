/**
 * SAG — Behavioral Security Engine
 * 
 * Transforms SAG from a stateless request filter into a stateful security system.
 * 
 * FEATURES:
 *  1. Rolling Risk Score — per-agent sliding window (last 50 requests)
 *  2. Anomaly Detection — flags sudden behavioral changes
 *  3. Alert Escalation — auto-suspend agents exceeding thresholds
 *  4. Cross-Request Pattern Analysis — detects probing/enumeration
 */
const { getDb, uuidv4 } = require('./database');

// ─── Per-Agent Behavioral State (in-memory, persisted to DB on key events) ───
const agentProfiles = new Map();
const WINDOW_SIZE = 50;          // Rolling window of last N requests
const ANOMALY_SPIKE = 25;        // Score jump that triggers anomaly alert
const SUSPENSION_THRESHOLD = 80; // Average risk above this → auto-suspend
const PROBE_WINDOW_MS = 10_000;  // 10s window for probing detection
const PROBE_THRESHOLD = 5;       // 5+ distinct tools in 10s = probing

// ─── Metrics ───
const metrics = {
    totalAnalyzed: 0,
    anomaliesDetected: 0,
    autoSuspensions: 0,
    probeAlerts: 0,
};

/**
 * Get or create agent behavioral profile.
 */
function getProfile(agentId) {
    if (!agentProfiles.has(agentId)) {
        agentProfiles.set(agentId, {
            agentId,
            recentScores: [],
            recentTools: [],        // { tool, ts }
            rollingAverage: 0,
            peakScore: 0,
            totalRequests: 0,
            anomalyCount: 0,
            lastRequestTime: 0,
        });
    }
    return agentProfiles.get(agentId);
}

/**
 * Record a request and compute behavioral signals.
 * 
 * @param {string} agentId - Agent UUID
 * @param {string} agentName - Agent display name
 * @param {string} tool - Tool being called
 * @param {number} riskScore - The risk score from risk-engine.js
 * @param {number} semanticScore - The score from intent-analyzer.js
 * @param {string} projectId - Workspace ID
 * @returns {{ rollingAverage, isAnomaly, isProbing, shouldSuspend, alerts[] }}
 */
function recordAndAnalyze({ agentId, agentName, tool, riskScore, semanticScore, projectId, probeThreshold }) {
    const profile = getProfile(agentId);
    const now = Date.now();
    const combinedScore = Math.max(riskScore || 0, semanticScore || 0);
    
    metrics.totalAnalyzed++;
    profile.totalRequests++;

    // 1. Update rolling scores window
    profile.recentScores.push(combinedScore);
    if (profile.recentScores.length > WINDOW_SIZE) {
        profile.recentScores.shift();
    }
    
    // 2. Update rolling tools window (for probing detection)
    profile.recentTools.push({ tool, ts: now });
    profile.recentTools = profile.recentTools.filter(t => now - t.ts < PROBE_WINDOW_MS);

    // 3. Calculate rolling average
    const sum = profile.recentScores.reduce((a, b) => a + b, 0);
    const prevAvg = profile.rollingAverage;
    profile.rollingAverage = Math.round(sum / profile.recentScores.length);
    profile.peakScore = Math.max(profile.peakScore, combinedScore);
    profile.lastRequestTime = now;

    const alerts = [];

    // ─── ANOMALY DETECTION: Sudden spike ───
    const isAnomaly = profile.recentScores.length >= 3 && 
                      combinedScore - prevAvg >= ANOMALY_SPIKE;
    if (isAnomaly) {
        profile.anomalyCount++;
        metrics.anomaliesDetected++;
        const alert = {
            type: 'ANOMALY_SPIKE',
            severity: combinedScore >= 80 ? 'critical' : 'high',
            title: `Behavioral anomaly: ${agentName}`,
            description: `Risk score spiked from avg ${prevAvg} to ${combinedScore} (+${combinedScore - prevAvg}). Tool: ${tool}`,
            agentId,
            agentName,
        };
        alerts.push(alert);
        persistAlert(alert, projectId);
    }

    // ─── PROBING DETECTION: Many distinct tools in short window ───
    const distinctTools = new Set(profile.recentTools.map(t => t.tool));
    const isProbing = distinctTools.size >= (probeThreshold || PROBE_THRESHOLD);
    // One alert per window: a sustained burst is one finding, not one per request.
    if (isProbing && now - (profile.lastProbeAlertAt || 0) > PROBE_WINDOW_MS) {
        profile.lastProbeAlertAt = now;
        metrics.probeAlerts++;
        const alert = {
            type: 'PROBING_DETECTED',
            severity: 'high',
            title: `Tool enumeration: ${agentName}`,
            description: `Agent accessed ${distinctTools.size} distinct tools in ${PROBE_WINDOW_MS / 1000}s: ${[...distinctTools].join(', ')}`,
            agentId,
            agentName,
        };
        alerts.push(alert);
        persistAlert(alert, projectId);
    }

    // ─── AUTO-SUSPENSION: Sustained high risk ───
    const shouldSuspend = profile.recentScores.length >= 10 && 
                          profile.rollingAverage >= SUSPENSION_THRESHOLD;
    if (shouldSuspend) {
        metrics.autoSuspensions++;
        const alert = {
            type: 'AUTO_SUSPENSION',
            severity: 'critical',
            title: `Agent auto-suspended: ${agentName}`,
            description: `Rolling average risk ${profile.rollingAverage} exceeds threshold ${SUSPENSION_THRESHOLD}. Agent suspended.`,
            agentId,
            agentName,
        };
        alerts.push(alert);
        persistAlert(alert, projectId);
        
        // Actually suspend the agent
        try {
            const db = getDb();
            db.prepare("UPDATE agents SET status = 'suspended' WHERE id = ?").run(agentId);
            console.warn(`[BEHAVIORAL] ⛔ Auto-suspended agent: ${agentName} (avg risk: ${profile.rollingAverage})`);
        } catch (e) {
            console.error('[BEHAVIORAL] Failed to suspend agent:', e.message);
        }
    }

    return {
        rollingAverage: profile.rollingAverage,
        peakScore: profile.peakScore,
        totalRequests: profile.totalRequests,
        anomalyCount: profile.anomalyCount,
        isAnomaly,
        isProbing,
        shouldSuspend,
        alerts,
    };
}

/**
 * Persist a behavioral alert to the threat_alerts table.
 */
function persistAlert(alert, projectId) {
    try {
        const db = getDb();
        db.prepare(`
            INSERT INTO threat_alerts (id, project_id, severity, type, title, description, agent_id, agent_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            uuidv4(),
            projectId || 'default_project',
            alert.severity,
            alert.type,
            alert.title,
            alert.description,
            alert.agentId || null,
            alert.agentName || null
        );
    } catch (e) {
        console.error('[BEHAVIORAL] Failed to persist alert:', e.message);
    }
}

/**
 * Get the behavioral profile for an agent.
 */
function getAgentProfile(agentId) {
    const profile = agentProfiles.get(agentId);
    if (!profile) return null;
    return {
        agentId: profile.agentId,
        rollingAverage: profile.rollingAverage,
        peakScore: profile.peakScore,
        totalRequests: profile.totalRequests,
        anomalyCount: profile.anomalyCount,
        windowSize: profile.recentScores.length,
    };
}

/**
 * Get all agent profiles (for dashboard).
 */
function getAllProfiles() {
    const result = [];
    for (const [id, profile] of agentProfiles) {
        result.push({
            agentId: id,
            rollingAverage: profile.rollingAverage,
            peakScore: profile.peakScore,
            totalRequests: profile.totalRequests,
            anomalyCount: profile.anomalyCount,
        });
    }
    return result;
}

/**
 * Get engine metrics for observability.
 */
function getEngineMetrics() {
    return {
        ...metrics,
        trackedAgents: agentProfiles.size,
    };
}

module.exports = { recordAndAnalyze, getAgentProfile, getAllProfiles, getEngineMetrics };
