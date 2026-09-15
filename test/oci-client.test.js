'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { signGetRequest, listInstances } = require('../lib/oci-client');

// BI26091506: a fresh, disposable test keypair -- never the real
// Bitwarden-held OCI_PRIVATE_KEY. Generated once per test run, discarded
// after; nothing here ever touches a real secret value.
function testKeyPair() {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
}

test('signGetRequest produces a verifiable RSA-SHA256 signature over the exact date/(request-target)/host string', () => {
  const { publicKey, privateKey } = testKeyPair();
  const date = 'Tue, 15 Sep 2026 12:00:00 GMT';
  const auth = signGetRequest({
    method: 'GET', host: 'iaas.us-ashburn-1.oraclecloud.com', path: '/20160918/instances?compartmentId=ocid1.tenancy.oc1..abc',
    date, tenancyOcid: 'ocid1.tenancy.oc1..abc', userOcid: 'ocid1.user.oc1..def', fingerprint: 'aa:bb:cc', privateKeyPem: privateKey,
  });
  assert.match(auth, /^Signature version="1"/);
  assert.match(auth, /keyId="ocid1\.tenancy\.oc1\.\.abc\/ocid1\.user\.oc1\.\.def\/aa:bb:cc"/);
  assert.match(auth, /algorithm="rsa-sha256"/);
  assert.match(auth, /headers="date \(request-target\) host"/);

  const sigMatch = auth.match(/signature="([^"]+)"/);
  assert.ok(sigMatch);
  const signingString = [
    `date: ${date}`,
    '(request-target): get /20160918/instances?compartmentId=ocid1.tenancy.oc1..abc',
    'host: iaas.us-ashburn-1.oraclecloud.com',
  ].join('\n');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signingString);
  verifier.end();
  assert.equal(verifier.verify(publicKey, sigMatch[1], 'base64'), true, 'the signature must verify against the signing string with the matching public key');
});

test('listInstances returns ok:false without throwing when credentials are incomplete, never attempting a request', async () => {
  let called = false;
  const r = await listInstances({ tenancyOcid: 'ocid1.tenancy.oc1..abc', requestImpl: async () => { called = true; return { status: 200, data: [] }; } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.instances, []);
  assert.equal(called, false, 'an incomplete credential set must never reach the network');
});

test('listInstances maps a real ListInstances response shape to a flat instance list', async () => {
  const { privateKey } = testKeyPair();
  const requestImpl = async () => ({
    status: 200,
    data: [
      { id: 'ocid1.instance.oc1..prod', displayName: 'isconl-vault-a1', shape: 'VM.Standard.A1.Flex', lifecycleState: 'RUNNING', availabilityDomain: 'AD-1', timeCreated: '2026-08-01T00:00:00Z' },
      { id: 'ocid1.instance.oc1..stray1', displayName: 'unnamed', shape: 'VM.Standard.E2.1.Micro', lifecycleState: 'RUNNING', availabilityDomain: 'AD-1', timeCreated: '2026-01-01T00:00:00Z' },
    ],
  });
  const r = await listInstances({ tenancyOcid: 't', userOcid: 'u', fingerprint: 'f', region: 'us-ashburn-1', privateKeyPem: privateKey, requestImpl });
  assert.equal(r.ok, true);
  assert.equal(r.instances.length, 2);
  assert.equal(r.instances[0].name, 'isconl-vault-a1');
  assert.equal(r.instances[1].name, 'unnamed');
});

test('listInstances surfaces the OCI error message on a non-200 rather than throwing', async () => {
  const { privateKey } = testKeyPair();
  const requestImpl = async () => ({ status: 401, data: { message: 'NotAuthenticated' } });
  const r = await listInstances({ tenancyOcid: 't', userOcid: 'u', fingerprint: 'f', region: 'us-ashburn-1', privateKeyPem: privateKey, requestImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NotAuthenticated');
});

test('listInstances resolves ok:false on a network error rather than rejecting', async () => {
  const { privateKey } = testKeyPair();
  const requestImpl = async () => { throw new Error('ECONNRESET'); };
  const r = await listInstances({ tenancyOcid: 't', userOcid: 'u', fingerprint: 'f', region: 'us-ashburn-1', privateKeyPem: privateKey, requestImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNRESET/);
});

test('listInstances defaults compartmentId to the tenancy OCID when none is given', async () => {
  const { privateKey } = testKeyPair();
  let seenPath;
  const requestImpl = async (opts) => { seenPath = opts.path; return { status: 200, data: [] }; };
  await listInstances({ tenancyOcid: 'ocid1.tenancy.oc1..root', userOcid: 'u', fingerprint: 'f', region: 'us-ashburn-1', privateKeyPem: privateKey, requestImpl });
  assert.match(seenPath, /compartmentId=ocid1\.tenancy\.oc1\.\.root/);
});
