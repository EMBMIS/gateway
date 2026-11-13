/**
 * DWI — Encrypted Data Vault
 * AES-256-GCM encrypted credential and data store.
 * All data encrypted at rest with hardware-backed key derivation (simulated).
 * Supports GDPR Article 17 — Right to Erasure.
 */
const crypto = require('crypto');
const { getDb, uuidv4 } = require('./database');
const keys = require('./keys');

/**
 * Key hierarchy: one master key (32 random bytes from SAG_VAULT_MASTER_KEY or <secrets dir>/vault-master.key; see
 * DEPLOY.md) → a per-asset key derived with HKDF from the asset's key id. Destroying an asset's key id (it is
 * overwritten on erasure) makes that asset unrecoverable without touching any other.
 *
 * The master key is held by the process, not by a KMS/HSM: whoever can read the gateway's secrets can read the vault.
 * Production refuses to start without it (src/keys.js). Outside production a missing key falls back to a
 * throw-away one, so assets stored that way do not survive a restart.
 */
const ALGORITHM = 'aes-256-gcm';
let MASTER_KEY = null;

function masterKey() {
    if (MASTER_KEY) return MASTER_KEY;
    MASTER_KEY = keys.readVaultMasterKey();
    if (!MASTER_KEY) {
        if (keys.isProduction()) throw new keys.KeyError('Vault master key is missing. Provide SAG_VAULT_MASTER_KEY or vault-master.key in the secrets directory.');
        console.warn('[VAULT] No vault master key configured; using a throw-away key (assets will not survive a restart). Set SAG_VAULT_MASTER_KEY.');
        MASTER_KEY = crypto.randomBytes(32);
    }
    return MASTER_KEY;
}

/** Per-asset encryption key. */
function deriveKey(keyId) {
    return Buffer.from(crypto.hkdfSync('sha256', masterKey(), Buffer.alloc(0), `sag-vault-asset:${keyId}`, 32));
}

/** A stable, non-reversible tag for a person, so the vault can find their assets without storing the identifier. */
function subjectHash(identifier) {
    return crypto.createHmac('sha256', masterKey()).update(`subject:${String(identifier).trim().toLowerCase()}`).digest('hex');
}

/**
 * Encrypt data and store it in the vault. `subject` (an email, customer id, …) ties the asset to one person
 * so that an erasure request for that person can destroy exactly their assets.
 */
function storeAsset({ name, classification, data, subject }) {
    if (!name || !classification) throw new Error('name and classification are required');
    const db = getDb();
    const id = uuidv4();
    const keyId = uuidv4();
    const key = deriveKey(keyId);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    const requiresTee = ['PII', 'FINANCIAL', 'HEALTH', 'CREDENTIAL'].includes(classification);
    const subjectTag = subject && String(subject).trim() ? subjectHash(subject) : null;

    db.prepare(`
    INSERT INTO vault_assets (id, name, classification, encrypted_data, encryption_key_id, iv, auth_tag, tee_protected, subject_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, classification, encrypted, keyId, iv.toString('hex'), authTag, requiresTee ? 1 : 0, subjectTag);

    return { id, name, classification, keyId, teeProtected: requiresTee, hasSubject: !!subjectTag, encryptedSize: encrypted.length };
}

/**
 * Retrieve and decrypt an asset from the vault.
 * Access is logged. Agent must be authorized.
 */
function retrieveAsset(assetId, agentId) {
    const db = getDb();
    const asset = db.prepare('SELECT * FROM vault_assets WHERE id = ?').get(assetId);
    if (!asset) return { error: 'Asset not found' };

    const key = deriveKey(asset.encryption_key_id);
    const iv = Buffer.from(asset.iv, 'hex');
    const authTag = Buffer.from(asset.auth_tag, 'hex');

    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(asset.encrypted_data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        // Log access
        db.prepare(`
      INSERT INTO vault_access_log (id, asset_id, agent_id, action, status)
      VALUES (?, ?, ?, 'READ', 'approved')
    `).run(uuidv4(), assetId, agentId);

        return { id: asset.id, name: asset.name, classification: asset.classification, data: JSON.parse(decrypted) };
    } catch (err) {
        // Log failed access
        db.prepare(`
      INSERT INTO vault_access_log (id, asset_id, agent_id, action, status)
      VALUES (?, ?, ?, 'READ', 'failed_decryption')
    `).run(uuidv4(), assetId, agentId);

        return { error: 'Decryption failed — possible data tampering', detail: err.message };
    }
}

/**
 * List vault assets (metadata only — no decrypted data).
 */
function listAssets() {
    const db = getDb();
    return db.prepare(`
    SELECT id, name, classification, encryption_key_id, tee_protected, (subject_hash IS NOT NULL) AS has_subject,
           length(encrypted_data) as encrypted_size, created_at, updated_at
    FROM vault_assets ORDER BY created_at DESC
  `).all();
}

/**
 * Get vault access log.
 */
function getAccessLog(assetId, limit = 50) {
    const db = getDb();
    if (assetId) {
        return db.prepare(`
      SELECT val.*, a.name as agent_name
      FROM vault_access_log val
      LEFT JOIN agents a ON val.agent_id = a.id
      WHERE val.asset_id = ? ORDER BY val.created_at DESC LIMIT ?
    `).all(assetId, limit);
    }
    return db.prepare(`
    SELECT val.*, a.name as agent_name, va.name as asset_name
    FROM vault_access_log val
    LEFT JOIN agents a ON val.agent_id = a.id
    LEFT JOIN vault_assets va ON val.asset_id = va.id
    ORDER BY val.created_at DESC LIMIT ?
  `).all(limit);
}

/**
 * GDPR Article 17 — erase one person's data. Finds the assets stored for that subject, overwrites each one's
 * ciphertext and key id (so the derived key can never be recomputed), and records a proof hash.
 * Assets stored without a subject are not touched. Returns assetsAffected: 0 when nothing was stored for the person.
 */
function processErasure(userIdentifier) {
    const who = String(userIdentifier || '').trim();
    if (!who) throw new Error('userIdentifier is required');
    const db = getDb();
    const requestId = uuidv4();
    const start = process.hrtime.bigint();

    db.prepare(`
    INSERT INTO erasure_requests (id, user_identifier, status)
    VALUES (?, ?, 'processing')
  `).run(requestId, who);

    const assets = db.prepare('SELECT id, name FROM vault_assets WHERE subject_hash = ?').all(subjectHash(who));

    const shred = db.prepare(`
      UPDATE vault_assets SET encryption_key_id = ?, iv = ?, auth_tag = ?, encrypted_data = ?, subject_hash = NULL, updated_at = datetime('now')
      WHERE id = ?`);
    for (const asset of assets) {
        // The old key id is replaced and never stored again: the old ciphertext is gone too, so nothing can decrypt it.
        const newKeyId = uuidv4();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(newKeyId), iv);
        let encrypted = cipher.update(JSON.stringify({ erased: true, requestId }), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        shred.run(newKeyId, iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted, asset.id);
    }

    const proofHash = crypto.createHash('sha256').update(
        JSON.stringify({ requestId, subject: subjectHash(who), assetsAffected: assets.map(a => a.id), timestamp: new Date().toISOString() })
    ).digest('hex');

    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    db.prepare(`
    UPDATE erasure_requests SET status = 'completed', proof_hash = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(proofHash, requestId);

    return {
        requestId,
        userIdentifier: who,
        status: 'completed',
        assetsAffected: assets.length,
        proofHash,
        elapsedMs: elapsedMs.toFixed(2),
    };
}

/**
 * List erasure requests.
 */
function listErasureRequests() {
    const db = getDb();
    return db.prepare('SELECT * FROM erasure_requests ORDER BY created_at DESC, id DESC').all();
}

/**
 * Seed default vault assets.
 */
function seedVault() {
    // Demo assets are for development only; a production vault starts empty.
    if (keys.isProduction() && process.env.SAG_SEED_DEMO !== '1') return;
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM vault_assets').get().c;
    if (count > 0) return;

    storeAsset({ name: 'Customer PII Database', classification: 'PII', subject: 'demo-customer@example.com', data: { schema: 'customers', fields: ['name', 'email', 'address', 'phone', 'dob'], recordCount: 1200000, region: 'EU-WEST-1' } });
    storeAsset({ name: 'Financial Transaction Ledger', classification: 'FINANCIAL', data: { schema: 'transactions', fields: ['amount', 'currency', 'sender', 'recipient', 'date'], recordCount: 8400000 } });
    storeAsset({ name: 'Patient Health Records', classification: 'HEALTH', data: { schema: 'patients_fhir', format: 'HL7-FHIR', fields: ['patient_id', 'conditions', 'medications', 'allergies'], recordCount: 340000 } });
    storeAsset({ name: 'Internal Employee Docs', classification: 'INTERNAL', data: { schema: 'hr_documents', fields: ['employee_id', 'contract', 'reviews'], recordCount: 52000 } });
    storeAsset({ name: 'API Credentials', classification: 'CREDENTIAL', data: { services: ['salesforce', 'stripe', 'slack', 'aws'], tokenType: 'short_lived', rotationInterval: '1h' } });

    console.log('[VAULT] Seeded 5 encrypted vault assets');
}

module.exports = { storeAsset, retrieveAsset, listAssets, getAccessLog, processErasure, listErasureRequests, seedVault };
