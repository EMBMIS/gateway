const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const fs = require('fs');
const forge = require('node-forge');

const PROTO_PATH = path.join(__dirname, '..', 'src', 'proto', 'intent.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const authz = grpc.loadPackageDefinition(packageDefinition).authz;

const certsDir = path.join(__dirname, '..', 'certs');
const caCert = fs.readFileSync(path.join(certsDir, 'ca-cert.pem'));
const clientCert = fs.readFileSync(path.join(certsDir, 'client-cert.pem'));
const clientKey = fs.readFileSync(path.join(certsDir, 'client-key.pem'));

// Generate a random, untrusted certificate for testing
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
cert.setSubject([{ name: 'commonName', value: 'Rogue Client' }]);
cert.setIssuer([{ name: 'commonName', value: 'Rogue CA' }]);
cert.sign(keys.privateKey, forge.md.sha256.create());
const rogueCert = forge.pki.certificateToPem(cert);
const rogueKey = forge.pki.privateKeyToPem(keys.privateKey);

const target = 'localhost:50051';

function testRpc(name, creds, expectFail) {
    return new Promise((resolve) => {
        console.log(`\n--- Testing ${name} ---`);
        const client = new authz.EnclaveWorker(target, creds);
        client.CheckHealth({}, (err, res) => {
            if (err) {
                if (expectFail) {
                    console.log(`[PASS] Transport failed as expected: ${err.message}`);
                } else {
                    console.error(`[FAIL] Transport failed unexpectedly: ${err.message}`);
                }
            } else {
                if (expectFail) {
                    console.error(`[FAIL] Connection succeeded when it should have failed!`);
                } else {
                    console.log(`[PASS] Transport succeeded properly. Enclave PID: ${res.worker_pid}`);
                }
            }
            resolve();
        });
    });
}

async function runTests() {
    console.log('=== mTLS Transportation Hardening Verification ===\n');
    console.log('Goal: Prove Worker drops unauthenticated traffic before execution flow.\n');

    const insecureCreds = grpc.credentials.createInsecure();
    await testRpc('Insecure Credentials (No TLS)', insecureCreds, true);

    const rogueCreds = grpc.credentials.createSsl(caCert, Buffer.from(rogueKey), Buffer.from(rogueCert));
    await testRpc('Rogue Credentials (Untrusted / Self-Signed TLS)', rogueCreds, true);

    const validCreds = grpc.credentials.createSsl(caCert, clientKey, clientCert);
    await testRpc('Valid Trusted CA Credentials (mTLS)', validCreds, false);
}

runTests();
