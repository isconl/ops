#!/usr/bin/env node
'use strict';
/**
 * ops engine -- HTTP entry point.
 *
 * Boot sequence (matches every other engine's): secrets -> audit log ->
 * ops-vm control surface -> bind. No vault dependency -- ops controls the
 * fleet's containers/VM, it doesn't read/write app data, so it has nothing
 * to fetch from vault at boot.
 */

const http = require('http');
const path = require('path');
const secretStore = require('../lib/secrets');
const { createAuditLog } = require('../lib/audit');
const { createOpsVm } = require('../lib/ops-vm');
const { createMachineRegistry } = require('../lib/machines');
const { createMetricsCollector } = require('../lib/metrics');
const manifest = require('../lib/manifest');

const PORT = parseInt(process.env.OPS_PORT || process.env.PORT || '8087', 10);
const BIND = process.env.OPS_BIND || '127.0.0.1';
const LOGS_DIR = process.env.OPS_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/** Static-token check only, same shape every engine uses. */
let _devAuthBypassLog = null; // set once main() creates auditLog; used by ISCONL_DEV_NO_AUTH (BS26090501)

function checkAuth(req) {
  // BS26090501: dev-only, loopback-gated (enforced at boot below), env-only -- never request-derived.
  if (process.env.ISCONL_DEV_NO_AUTH === '1') {
    if (_devAuthBypassLog) _devAuthBypassLog.log('dev_auth_bypass', { engine: 'ops', path: req.url });
    return true;
  }
  const token = process.env.OPS_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('OPS_TOKEN') || '';
  if (!token) return false;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return provided.length === token.length && provided === token;
}

async function main() {
  const secretsResult = await secretStore.init();
  console.log(`  secrets: ${secretsResult.source}, ${secretsResult.count} key(s)`);

  const auditLog = createAuditLog({ logsDir: LOGS_DIR });
  _devAuthBypassLog = auditLog;
  const opsVm = createOpsVm();

  // BI26091506: the machine registry -- additive, does not replace the
  // single-machine opsVm above (every existing route below is unchanged,
  // still scoped to whichever machine ops itself runs on, so the existing
  // hub UI keeps working exactly as before; the multi-machine UI is
  // PI26091504's job, not this row's). OCI credentials are read key-only
  // via secretStore, same pattern every other engine's secret access
  // uses -- if any field is missing, the registry falls back to
  // declared-machines-only and reports discoveryOk:false, never throws.
  const machineRegistry = createMachineRegistry({
    ociCreds: {
      tenancyOcid: process.env.OCI_TENANCY_OCID || secretStore.get('OCI_TENANCY_OCID') || '',
      userOcid: process.env.OCI_USER_OCID || secretStore.get('OCI_USER_OCID') || '',
      fingerprint: process.env.OCI_FINGERPRINT || secretStore.get('OCI_FINGERPRINT') || '',
      region: process.env.OCI_REGION || secretStore.get('OCI_REGION') || '',
      privateKeyPem: process.env.OCI_PRIVATE_KEY || secretStore.get('OCI_PRIVATE_KEY') || '',
    },
  });

  // BI26091904: metrics ring buffer for the ops dashboard's time-series
  // charts. Only ever samples declared+controllable machines (see
  // metrics.js's own header for why -- vmStats() has no way to report a
  // number for a machine it can't locally exec against). Hydrate each
  // declared machine's ring from yesterday's/today's NDJSON before the
  // first sample, so a restart doesn't show an empty chart.
  const metrics = createMetricsCollector({ listMachines: machineRegistry.listMachines, opsVmFor: machineRegistry.opsVmFor });
  for (const m of machineRegistry.loadDeclaredMachines()) metrics.hydrateFromDisk(m.id);
  metrics.start();

  const tokenConfigured = !!(process.env.OPS_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('OPS_TOKEN'));
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(BIND);
  if (process.env.ISCONL_DEV_NO_AUTH === '1' && !isLoopback) {
    console.error('  REFUSING TO BIND: ISCONL_DEV_NO_AUTH is set but BIND is not loopback -- dev auth bypass is loopback-only.');
    process.exit(1);
  }
  if (!isLoopback && !tokenConfigured) {
    console.error('  REFUSING TO BIND: no OPS_TOKEN/ISCONL_TOKEN configured and BIND is not loopback.');
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', engine: 'ops', version: manifest.version });
    }
    if (pathname === '/manifest' && req.method === 'GET') {
      return sendJson(res, 200, manifest);
    }

    if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });

    try {
      if (pathname === '/status' && req.method === 'GET') {
        return sendJson(res, 200, await opsVm.status());
      }
      if (pathname === '/vm/stats' && req.method === 'GET') {
        return sendJson(res, 200, await opsVm.vmStats());
      }

      const logsMatch = pathname.match(/^\/logs\/([a-z][a-z0-9-]*)$/);
      if (logsMatch && req.method === 'GET') {
        return sendJson(res, 200, await opsVm.logsTail(logsMatch[1], url.searchParams.get('lines')));
      }

      const serviceMatch = pathname.match(/^\/service\/([a-z][a-z0-9-]*)\/(restart|start|stop|destroy)$/);
      if (serviceMatch && req.method === 'POST') {
        const [, name, action] = serviceMatch;

        if (!(await opsVm.isManaged(name))) {
          return sendJson(res, 400, { ok: false, error: `"${name}" is not a managed service` });
        }

        // Destroy is the one irreversible-feeling action (removes the
        // container; image/volumes untouched, but it IS a real state
        // change to a live production service) -- require the caller to
        // echo the service name back as an explicit confirm, same
        // type-to-confirm guard the row's own scoping specifies for the
        // client UI, enforced again here server-side so a client bug can't
        // skip it.
        let body = {};
        if (action === 'destroy') {
          const bodyText = await readBody(req);
          body = bodyText ? JSON.parse(bodyText) : {};
          if (body.confirm !== name) {
            return sendJson(res, 400, { ok: false, error: `destroy requires {"confirm":"${name}"} in the request body` });
          }
        }

        const before = auditLog.log('ops_service_action_start', { service: name, action });
        const result = await opsVm.serviceAction(name, action);
        auditLog.log('ops_service_action_done', { service: name, action, ok: result.ok, code: result.code, traceHash: before.hash });
        return sendJson(res, result.ok ? 200 : 502, result);
      }

      if (pathname === '/deploy/status' && req.method === 'GET') {
        return sendJson(res, 200, await opsVm.deployStatus());
      }

      // BI26091506: multi-machine surface. GET /machines is the real
      // machine list (declared + live OCI poll, merged) -- "visible and
      // manageable" per Sconl's own framing; everything below is the
      // "manageable" half, scoped to one named machine at a time.
      if (pathname === '/machines' && req.method === 'GET') {
        return sendJson(res, 200, await machineRegistry.listMachines());
      }

      const NO_CONNECTION = (id) => ({ ok: false, error: `no connection info declared for machine "${id}" -- observable via GET /machines only` });

      const machineStatusMatch = pathname.match(/^\/machines\/([^/]+)\/status$/);
      if (machineStatusMatch && req.method === 'GET') {
        const vm = machineRegistry.opsVmFor(decodeURIComponent(machineStatusMatch[1]));
        if (!vm) return sendJson(res, 200, { services: [], groups: {}, ungrouped: [], discoveryOk: false, discoveryError: NO_CONNECTION(machineStatusMatch[1]).error });
        return sendJson(res, 200, await vm.status());
      }

      const machineLogsMatch = pathname.match(/^\/machines\/([^/]+)\/logs\/([a-z][a-z0-9-]*)$/);
      if (machineLogsMatch && req.method === 'GET') {
        const [, machineId, name] = machineLogsMatch;
        const vm = machineRegistry.opsVmFor(decodeURIComponent(machineId));
        if (!vm) return sendJson(res, 400, NO_CONNECTION(machineId));
        return sendJson(res, 200, await vm.logsTail(name, url.searchParams.get('lines')));
      }

      const machineDeployMatch = pathname.match(/^\/machines\/([^/]+)\/deploy\/status$/);
      if (machineDeployMatch && req.method === 'GET') {
        const vm = machineRegistry.opsVmFor(decodeURIComponent(machineDeployMatch[1]));
        if (!vm) return sendJson(res, 200, { services: [], discoveryOk: false, discoveryError: NO_CONNECTION(machineDeployMatch[1]).error });
        return sendJson(res, 200, await vm.deployStatus());
      }

      // BI26091904: 24h metrics history for one machine's dashboard charts.
      // Empty array (not an error) for a machine never sampled -- either
      // it's genuinely new, or it's declared-but-not-controllable/
      // undeclared, in which case it will always be empty (see metrics.js).
      const machineMetricsMatch = pathname.match(/^\/machines\/([^/]+)\/metrics$/);
      if (machineMetricsMatch && req.method === 'GET') {
        return sendJson(res, 200, { samples: metrics.history(decodeURIComponent(machineMetricsMatch[1])) });
      }

      const machineServiceMatch = pathname.match(/^\/machines\/([^/]+)\/service\/([a-z][a-z0-9-]*)\/(restart|start|stop|destroy)$/);
      if (machineServiceMatch && req.method === 'POST') {
        const [, machineId, name, action] = machineServiceMatch;
        const vm = machineRegistry.opsVmFor(decodeURIComponent(machineId));
        // No connection info at all is a stricter, more basic wall than
        // per-service ops.control: there is no compose file to read
        // isManaged/isControllable from in the first place, so this can
        // never fall through to a real action for an unreachable machine
        // -- the same "fails closed" property the row asks for, at the
        // machine level rather than the service level.
        if (!vm) return sendJson(res, 400, NO_CONNECTION(machineId));

        if (!(await vm.isManaged(name))) {
          return sendJson(res, 400, { ok: false, error: `"${name}" is not a managed service on machine "${machineId}"` });
        }

        let body = {};
        if (action === 'destroy') {
          const bodyText = await readBody(req);
          body = bodyText ? JSON.parse(bodyText) : {};
          if (body.confirm !== name) {
            return sendJson(res, 400, { ok: false, error: `destroy requires {"confirm":"${name}"} in the request body` });
          }
        }

        const before = auditLog.log('ops_service_action_start', { machine: machineId, service: name, action });
        const result = await vm.serviceAction(name, action);
        auditLog.log('ops_service_action_done', { machine: machineId, service: name, action, ok: result.ok, code: result.code, traceHash: before.hash });
        return sendJson(res, result.ok ? 200 : 502, result);
      }
    } catch (e) {
      return sendJson(res, 400, { success: false, error: String(e.message || e) });
    }

    return sendJson(res, 404, { error: 'Not Found' });
  });

  return new Promise((resolve) => {
    server.listen(PORT, BIND, () => {
      const actualPort = server.address().port;
      console.log(`  ops listening on ${BIND}:${actualPort}`);
      resolve({ server, opsVm, auditLog, secretStore, port: actualPort });
    });
  });
}

if (require.main === module) {
  main().catch(e => { console.error('ops failed to start:', e); process.exit(1); });
}

module.exports = { main };
