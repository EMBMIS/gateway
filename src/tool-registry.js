/**
 * DWI — Tool Registry
 * Cryptographically signed MCP tool manifest.
 * All tools must be registered and signed before any agent can call them.
 */
const crypto = require('crypto');
const { getDb, uuidv4 } = require('./database');

// Signing key — in production this would be an HSM-backed key
const REGISTRY_SECRET = crypto.randomBytes(32);

/**
 * Sign a tool manifest entry.
 */
function signTool(toolName, schema) {
    const payload = JSON.stringify({ name: toolName, schema });
    const sig = crypto.createHmac('sha256', REGISTRY_SECRET).update(payload).digest('hex');
    return sig;
}

/**
 * Verify a tool's signature.
 */
function verifyTool(toolName, schema, signature) {
    const expected = signTool(toolName, schema);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Register a new MCP tool in the gateway.
 */
function registerTool({ name, description, category, riskLevel, requiresTee, schema }) {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM tool_registry WHERE name = ?').get(name);
    if (existing) {
        throw new Error(`Tool "${name}" is already registered`);
    }

    const schemaJson = JSON.stringify(schema || {});
    const signature = signTool(name, schema || {});
    const id = uuidv4();

    db.prepare(`
    INSERT INTO tool_registry (id, name, description, category, risk_level, requires_tee, signature, schema_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, description || '', category || 'general', riskLevel || 'medium', requiresTee ? 1 : 0, signature, schemaJson);

    return { id, name, signature };
}

/**
 * Get a registered tool by name.
 */
function getTool(name) {
    const db = getDb();
    return db.prepare('SELECT * FROM tool_registry WHERE name = ?').get(name);
}

/**
 * List all registered tools.
 */
function listTools() {
    const db = getDb();
    return db.prepare('SELECT * FROM tool_registry ORDER BY name').all();
}

/**
 * Validate that a tool call references a registered, signed tool.
 */
function validateToolCall(toolName) {
    const tool = getTool(toolName);
    if (!tool) {
        return { valid: false, reason: `Tool "${toolName}" is not registered in the gateway` };
    }
    const schema = JSON.parse(tool.schema_json || '{}');
    const sigValid = verifyTool(toolName, schema, tool.signature);
    if (!sigValid) {
        return { valid: false, reason: `Tool "${toolName}" has an invalid signature — possible tampering` };
    }
    return { valid: true, tool };
}

/**
 * Seed the default MCP tools
 */
function seedTools() {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM tool_registry').get().c;
    if (count > 0) return;

    const tools = [
        { name: 'db.query', description: 'Execute read-only database queries', category: 'data', riskLevel: 'high', requiresTee: true, schema: { type: 'object', properties: { sql: { type: 'string' }, params: { type: 'array' } } } },
        { name: 'db.write', description: 'Write/mutate database records', category: 'data', riskLevel: 'critical', requiresTee: true, schema: { type: 'object', properties: { sql: { type: 'string' }, params: { type: 'array' } } } },
        { name: 'api.salesforce.read', description: 'Read Salesforce CRM data', category: 'crm', riskLevel: 'medium', requiresTee: false, schema: { type: 'object', properties: { object: { type: 'string' }, query: { type: 'string' } } } },
        { name: 'api.salesforce.write', description: 'Write to Salesforce CRM', category: 'crm', riskLevel: 'high', requiresTee: true, schema: {} },
        { name: 'email.send', description: 'Send email via SMTP gateway', category: 'communication', riskLevel: 'medium', requiresTee: false, schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } } },
        { name: 'file.read', description: 'Read files from enterprise storage', category: 'storage', riskLevel: 'medium', requiresTee: false, schema: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'file.write', description: 'Write files to enterprise storage', category: 'storage', riskLevel: 'high', requiresTee: true, schema: {} },
        { name: 'payment.initiate', description: 'Initiate financial payment', category: 'finance', riskLevel: 'critical', requiresTee: true, schema: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' }, recipient: { type: 'string' } } } },
        { name: 'calendar.update', description: 'Update calendar events', category: 'productivity', riskLevel: 'low', requiresTee: false, schema: {} },
        { name: 'slack.post', description: 'Post messages to Slack channels', category: 'communication', riskLevel: 'low', requiresTee: false, schema: { type: 'object', properties: { channel: { type: 'string' }, message: { type: 'string' } } } },
        { name: 'user.lookup', description: 'Look up user PII information', category: 'identity', riskLevel: 'high', requiresTee: true, schema: { type: 'object', properties: { userId: { type: 'string' } } } },
        { name: 'report.generate', description: 'Generate business reports', category: 'analytics', riskLevel: 'low', requiresTee: false, schema: {} },
        { name: 'inventory.check', description: 'Check inventory levels', category: 'operations', riskLevel: 'low', requiresTee: false, schema: {} },
        { name: 'order.create', description: 'Create purchase orders', category: 'operations', riskLevel: 'high', requiresTee: true, schema: { type: 'object', properties: { items: { type: 'array' }, supplier: { type: 'string' } } } },
    ];

    for (const t of tools) {
        registerTool(t);
    }
    console.log('[TOOL-REGISTRY] Seeded', tools.length, 'MCP tools');
}

module.exports = { registerTool, getTool, listTools, validateToolCall, seedTools };
