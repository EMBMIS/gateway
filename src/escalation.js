/**
 * SAG — Escalation Notifier
 * Sends Slack webhook and/or email alerts when an agent is flagged (escalate/deny/kill).
 * Config is per-workspace, stored in escalation_configs table.
 */
const { getDb } = require('./database');

/**
 * Send a Slack message via incoming webhook URL.
 */
async function sendSlack(webhookUrl, payload) {
    const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Slack webhook failed: ${res.status}`);
}

/**
 * Send an email via SMTP using nodemailer (optional dep).
 * Falls back gracefully if nodemailer is not installed.
 */
async function sendEmail({ smtpUrl, from, to, subject, text }) {
    let nodemailer;
    try {
        nodemailer = require('nodemailer');
    } catch (_) {
        console.warn('[ESCALATION] nodemailer not installed — skipping email. Run: npm install nodemailer');
        return;
    }
    const transporter = nodemailer.createTransport(smtpUrl);
    await transporter.sendMail({ from, to, subject, text });
}

/**
 * Build a human-readable Slack Block Kit message for an escalation event.
 */
function buildSlackPayload({ eventType, agentName, tool, action, riskScore, reason, traceId, projectId }) {
    const emoji = eventType === 'kill' ? '🔴' : eventType === 'escalate' ? '🟡' : '🟠';
    const title = eventType === 'kill'
        ? `${emoji} Agent Kill-Switch Activated`
        : eventType === 'escalate'
            ? `${emoji} Agent Escalation — Human Approval Required`
            : `${emoji} Agent Blocked — High Risk`;

    return {
        text: title,
        blocks: [
            {
                type: 'header',
                text: { type: 'plain_text', text: title, emoji: true },
            },
            {
                type: 'section',
                fields: [
                    { type: 'mrkdwn', text: `*Agent:*\n${agentName || 'unknown'}` },
                    { type: 'mrkdwn', text: `*Tool:*\n${tool || 'unknown'}` },
                    { type: 'mrkdwn', text: `*Action:*\n${action || 'EXECUTE'}` },
                    { type: 'mrkdwn', text: `*Risk Score:*\n${riskScore ?? 'N/A'}/100` },
                ],
            },
            {
                type: 'section',
                text: { type: 'mrkdwn', text: `*Reason:*\n${reason || 'No reason provided'}` },
            },
            {
                type: 'context',
                elements: [
                    { type: 'mrkdwn', text: `Trace: \`${traceId || 'none'}\` | Workspace: \`${projectId || 'default'}\`` },
                ],
            },
        ],
    };
}

/**
 * Build a plain-text email body for an escalation event.
 */
function buildEmailBody({ eventType, agentName, tool, action, riskScore, reason, traceId, projectId }) {
    return [
        `SAG Escalation Alert`,
        `====================`,
        `Event:      ${eventType}`,
        `Agent:      ${agentName || 'unknown'}`,
        `Tool:       ${tool || 'unknown'}`,
        `Action:     ${action || 'EXECUTE'}`,
        `Risk Score: ${riskScore ?? 'N/A'}/100`,
        `Reason:     ${reason || 'No reason provided'}`,
        `Trace ID:   ${traceId || 'none'}`,
        `Workspace:  ${projectId || 'default'}`,
        `Time:       ${new Date().toISOString()}`,
    ].join('\n');
}

/**
 * Main entry point — call this whenever an agent is escalated, blocked, or killed.
 * Looks up escalation config for the workspace and fires configured channels.
 *
 * @param {Object} event
 * @param {string} event.eventType  - 'escalate' | 'deny' | 'kill'
 * @param {string} event.projectId
 * @param {string} event.agentName
 * @param {string} event.tool
 * @param {string} event.action
 * @param {number} event.riskScore
 * @param {string} event.reason
 * @param {string} event.traceId
 */
async function notify(event) {
    const db = getDb();
    const configs = db.prepare(
        "SELECT * FROM escalation_configs WHERE project_id = ? AND enabled = 1"
    ).all(event.projectId || 'default_project');

    if (configs.length === 0) return; // no escalation configured for this workspace

    const slackPayload = buildSlackPayload(event);
    const emailSubject = `[SAG] ${event.eventType === 'kill' ? 'Kill-Switch' : 'Escalation'} — ${event.agentName || 'Agent'}`;
    const emailBody = buildEmailBody(event);

    const promises = configs.map(async (cfg) => {
        try {
            if (cfg.channel === 'slack' && cfg.slack_webhook_url) {
                await sendSlack(cfg.slack_webhook_url, slackPayload);
                console.log(`[ESCALATION] Slack notified for project ${event.projectId}`);
            }
            if (cfg.channel === 'email' && cfg.smtp_url && cfg.email_to) {
                await sendEmail({
                    smtpUrl: cfg.smtp_url,
                    from: cfg.email_from || 'sag-alerts@qira.one',
                    to: cfg.email_to,
                    subject: emailSubject,
                    text: emailBody,
                });
                console.log(`[ESCALATION] Email sent to ${cfg.email_to} for project ${event.projectId}`);
            }
        } catch (err) {
            console.error(`[ESCALATION] Notification failed (${cfg.channel}):`, err.message);
        }
    });

    await Promise.allSettled(promises);
}

/**
 * CRUD helpers for escalation_configs — used by server.js routes.
 */
function listConfigs(projectId) {
    const db = getDb();
    return db.prepare('SELECT * FROM escalation_configs WHERE project_id = ? ORDER BY created_at ASC').all(projectId);
}

function upsertConfig({ projectId, channel, slackWebhookUrl, smtpUrl, emailFrom, emailTo, minSeverity, enabled }) {
    const db = getDb();
    const { v4: uuidv4 } = require('uuid');
    const existing = db.prepare('SELECT id FROM escalation_configs WHERE project_id = ? AND channel = ?').get(projectId, channel);
    if (existing) {
        db.prepare(`
            UPDATE escalation_configs
            SET slack_webhook_url = ?, smtp_url = ?, email_from = ?, email_to = ?,
                min_severity = ?, enabled = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(slackWebhookUrl || null, smtpUrl || null, emailFrom || null, emailTo || null,
               minSeverity || 'high', enabled !== false ? 1 : 0, existing.id);
        return { id: existing.id, updated: true };
    }
    const id = uuidv4();
    db.prepare(`
        INSERT INTO escalation_configs (id, project_id, channel, slack_webhook_url, smtp_url, email_from, email_to, min_severity, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, channel, slackWebhookUrl || null, smtpUrl || null,
           emailFrom || null, emailTo || null, minSeverity || 'high', enabled !== false ? 1 : 0);
    return { id, created: true };
}

function deleteConfig(id) {
    const db = getDb();
    db.prepare('DELETE FROM escalation_configs WHERE id = ?').run(id);
}

module.exports = { notify, listConfigs, upsertConfig, deleteConfig };
