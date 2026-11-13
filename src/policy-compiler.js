const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const BUNDLE_PATH = require('./keys').bundlePath();

// 1. Recursive Canonical JSON Serialization
function canonicalize(obj) {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj) || 'null';
    }

    if (Array.isArray(obj)) {
        const arrElements = obj.map(item => canonicalize(item));
        return `[${arrElements.join(',')}]`;
    }

    // Object: sort keys alphabetically
    const sortedKeys = Object.keys(obj).sort();
    const objElements = sortedKeys.map(key => {
        // Keys are strings, so stringify them
        return `${JSON.stringify(key)}:${canonicalize(obj[key])}`;
    });

    return `{${objElements.join(',')}}`;
}

// 2. Fetch KMS Key Configuration
// The compiler no longer holds or generates the private key.
const KMS_URL = process.env.KMS_URL || 'http://localhost:4000';
// The leaked key id (alias/policy-authority-v0.4) is on the revocation list; never reuse it.
const KEY_ID = process.env.SAG_POLICY_KEY_ID || 'alias/policy-authority-dev';

async function signWithKMS(payloadCanonicalString) {
    const payloadBuffer = Buffer.from(payloadCanonicalString, 'utf8');

    // AWS Equivalent: kms.sign({ KeyId, Message: payloadBuffer })
    const res = await fetch(`${KMS_URL}/kms/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            KeyId: KEY_ID,
            Message: payloadBuffer.toString('base64'),
            MessageType: 'RAW'
        })
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(`KMS Signing Failed: ${err.message || err.error}`);
    }

    return await res.json();
}

// 3. Define the Static Policy Logic (extracted from dynamic DB)
function buildPolicyLogic() {
    return {
        version: parseInt(process.env.BUNDLE_VERSION || '2', 10),
        policies: [
            {
                id: "pol-101",
                name: "Block All DELETE Operations",
                description: "Deny all DELETE actions",
                priority: 1,
                effect: "deny",
                conditions: {
                    action: "DELETE"
                }
            },
            {
                id: "pol-102",
                name: "Block DROP TABLE",
                description: "Deny all DROP TABLE actions",
                priority: 1,
                effect: "deny",
                conditions: {
                    action: "DROP_TABLE"
                }
            }
        ],
        role_permissions: {
            "SystemAdmin": {
                "db.query": "allow",
                "db.write": "allow",
                "system.config": "allow"
            },
            "finance": { // Matches the agent role for FinanceAgent-7
                "db.query": "allow",
                "db.write": "deny",
                "user.lookup": "allow",
                "report.generate": "allow",
                "payment.initiate": "allow",
                "system.config": "deny"
            },
            "hr": { // Matches the agent role for HRAssist-Pro
                "db.query": "allow",
                "db.write": "allow",
                "user.lookup": "allow",
                "system.config": "deny"
            },
            "engineering": { // Matches Codex-Alpha
                "db.query": "allow",
                "db.write": "allow",
                "user.lookup": "allow",
                "system.config": "allow"
            }
        },
        risk_thresholds: {
            "autoBlock": 85,
            "requiresHumanApproval": 60
        },
        tool_registry: {
            "db.query": { "description": "Execute read-only SQL" },
            "db.write": { "description": "Execute mutating SQL" },
            "user.lookup": { "description": "Lookup user by ID" },
            "report.generate": { "description": "Generate business reports" },
            "payment.initiate": { "description": "Initiate a wire transfer" },
            "system.config": { "description": "Modify system config" }
        }
    };
}

// 4. Compile the Bundle
async function compile() {
    console.log('=== SOVEREIGN AGENT GATEWAY ===');
    console.log('--- Offline Policy Compiler ---');

    const bundle = buildPolicyLogic();

    // Create deterministic canonical string of JUST the bundle payload
    const canonicalString = canonicalize(bundle);
    console.log('Payload Canonical Length:', canonicalString.length);

    // Calculate SHA-256 Hash of canonical string
    const hash = crypto.createHash('sha256').update(canonicalString).digest('hex');
    console.log('Policy Bundle Hash:', hash);

    // Delineate Trust Boundary: Send to external KMS Authority for signing
    console.log(`Requesting signature from external KMS for key: ${KEY_ID}...`);
    const kmsResponse = await signWithKMS(canonicalString);
    console.log('Signature returned successfully from external KMS.');

    // Construct final artifact
    const artifact = {
        metadata: {
            version: "1.0.0",
            compiler_version: "0.4.0",
            created_at: new Date().toISOString(),
            policy_bundle_hash: hash
        },
        bundle: bundle,
        signature: kmsResponse.Signature,
        key_id: kmsResponse.KeyId
    };

    // Write to disk
    fs.writeFileSync(BUNDLE_PATH, JSON.stringify(artifact, null, 2), 'utf8');
    console.log(`\nSuccess. Wrote KMS-signed policy bundle to ${BUNDLE_PATH}`);
}

if (require.main === module) {
    compile().catch(err => {
        console.error('Fatal Backend Error compiling bundle:', err);
        process.exit(1);
    });
}

module.exports = { canonicalize, buildPolicyLogic, KEY_ID, BUNDLE_PATH };
