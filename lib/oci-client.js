'use strict';
/**
 * A minimal OCI (Oracle Cloud Infrastructure) API client -- request signing
 * plus one call, ListInstances. Zero dependencies, same style as
 * vault/lib/graph.js's own HTTPS client: no SDK, plain https.request and
 * node's built-in crypto, matching this fleet's house convention rather
 * than pulling in the official OCI SDK for one endpoint.
 *
 * BI26091506: "all VMs in OCI" means querying OCI's own Compute API for
 * the full instance list, not a hardcoded second entry -- this is that
 * query. Credentials (OCI_TENANCY_OCID/OCI_USER_OCID/OCI_REGION/
 * OCI_FINGERPRINT/OCI_PRIVATE_KEY) are the full API signing-key set,
 * already confirmed present in Bitwarden by a key-only existence check
 * (CLAUDE.md §17 -- never a command whose output shape can include the
 * value). Nothing in this file logs a key, a signature, or a private-key
 * PEM; the only things logged (by callers) are instance shapes (id,
 * display name, lifecycle state), which are not secrets.
 *
 * OCI's request-signing scheme (API Signing Key, version 1): sign a
 * canonical string built from a fixed set of headers, RSA-SHA256, base64
 * the signature, put it in the Authorization header alongside a keyId
 * built from tenancy/user/fingerprint. Documented publicly by Oracle;
 * implemented here directly against that spec rather than a guess.
 */

const https = require('https');
const crypto = require('crypto');

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = raw; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** RFC 1123 date, exactly the format OCI's signing spec requires. */
function rfc1123Date(d = new Date()) {
  return d.toUTCString().replace('GMT', 'GMT');
}

/**
 * Builds the OCI Authorization header for a GET request (no body -- POST/
 * PUT would additionally need content-length/content-type/x-content-sha256
 * signed, not needed for ListInstances and not implemented here since
 * nothing in this row calls a write endpoint).
 */
function signGetRequest({ method, host, path, date, tenancyOcid, userOcid, fingerprint, privateKeyPem }) {
  const requestTarget = `${method.toLowerCase()} ${path}`;
  const signingString = [
    `date: ${date}`,
    `(request-target): ${requestTarget}`,
    `host: ${host}`,
  ].join('\n');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingString);
  signer.end();
  const signature = signer.sign(privateKeyPem, 'base64');
  const keyId = `${tenancyOcid}/${userOcid}/${fingerprint}`;
  return `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="date (request-target) host",signature="${signature}"`;
}

/**
 * GET /20160918/instances?compartmentId=... -- every instance in a
 * compartment, any lifecycle state. `compartmentId` defaults to the
 * tenancy OCID (the root compartment), the common shape for a small
 * tenancy where nothing has been split into sub-compartments -- pass one
 * explicitly if that's ever not true.
 *
 * Returns `{ok:false, error}` rather than throwing on any failure (auth,
 * network, malformed response) -- a caller (machines.js) must be able to
 * distinguish "the live poll couldn't run" from "it ran and found zero
 * instances," the same discoveryOk/discoveryError shape ops-vm.js already
 * uses for docker compose discovery.
 */
async function listInstances({ tenancyOcid, userOcid, fingerprint, region, privateKeyPem, compartmentId, requestImpl = httpsRequest } = {}) {
  if (!tenancyOcid || !userOcid || !fingerprint || !region || !privateKeyPem) {
    return { ok: false, error: 'OCI credentials incomplete -- need tenancyOcid/userOcid/fingerprint/region/privateKeyPem', instances: [] };
  }
  const host = `iaas.${region}.oraclecloud.com`;
  const compartment = compartmentId || tenancyOcid;
  const path = `/20160918/instances?compartmentId=${encodeURIComponent(compartment)}`;
  const date = rfc1123Date();
  let authorization;
  try {
    authorization = signGetRequest({ method: 'GET', host, path, date, tenancyOcid, userOcid, fingerprint, privateKeyPem });
  } catch (e) {
    return { ok: false, error: `failed to sign OCI request: ${String(e.message || e)}`, instances: [] };
  }
  let r;
  try {
    r = await requestImpl({ hostname: host, path, method: 'GET', headers: { date, host, Authorization: authorization } });
  } catch (e) {
    return { ok: false, error: String(e.message || e), instances: [] };
  }
  if (r.status !== 200) {
    const msg = (r.data && r.data.message) || `OCI HTTP ${r.status}`;
    return { ok: false, error: msg, instances: [] };
  }
  const instances = (Array.isArray(r.data) ? r.data : []).map(i => ({
    id: i.id,
    name: i.displayName,
    shape: i.shape,
    lifecycleState: i.lifecycleState,
    availabilityDomain: i.availabilityDomain,
    timeCreated: i.timeCreated,
  }));
  return { ok: true, error: null, instances };
}

module.exports = { signGetRequest, listInstances, rfc1123Date };
