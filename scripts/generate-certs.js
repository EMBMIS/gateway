const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const certsDir = require('../src/keys').secretsDir();
if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

function generateCertAndKey(subjectName, isCA, caCert, caKey) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    const attrs = [{ name: 'commonName', value: subjectName }];
    cert.setSubject(attrs);
    cert.setIssuer(isCA ? attrs : caCert.subject.attributes);

    const extensions = [{
        name: 'basicConstraints',
        cA: isCA
    }, {
        name: 'keyUsage',
        keyCertSign: isCA,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true
    }, {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true,
    }, {
        // Crucial: define SAN for strict host matching 'localhost' over gRPC
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }]
    }];

    cert.setExtensions(extensions);

    // Sign the cert
    cert.sign(isCA ? keys.privateKey : caKey, forge.md.sha256.create());

    return {
        certPem: forge.pki.certificateToPem(cert),
        keyPem: forge.pki.privateKeyToPem(keys.privateKey),
        certObj: cert,
        keyObj: keys.privateKey
    };
}

console.log('Generating Root CA...');
const ca = generateCertAndKey('DWI Root CA', true);

console.log('Generating Enclave Server Cert...');
const server = generateCertAndKey('localhost', false, ca.certObj, ca.keyObj);

console.log('Generating Gateway Client Cert...');
const client = generateCertAndKey('DWI Gateway', false, ca.certObj, ca.keyObj);

fs.writeFileSync(path.join(certsDir, 'ca-cert.pem'), ca.certPem);
fs.writeFileSync(path.join(certsDir, 'ca-key.pem'), ca.keyPem, { mode: 0o600 });

fs.writeFileSync(path.join(certsDir, 'server-cert.pem'), server.certPem);
fs.writeFileSync(path.join(certsDir, 'server-key.pem'), server.keyPem, { mode: 0o600 });

fs.writeFileSync(path.join(certsDir, 'client-cert.pem'), client.certPem);
fs.writeFileSync(path.join(certsDir, 'client-key.pem'), client.keyPem, { mode: 0o600 });

console.log('Successfully generated strict mTLS configuration in the secrets directory (SAG_SECRETS_DIR, default certs/).');
