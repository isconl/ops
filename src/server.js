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
function checkAuth(req) {
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
  const opsVm = createOpsVm();

  const tokenConfigured = !!(process.env.OPS_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('OPS_TOKEN'));
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(BIND);
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

      const logsMatch = pathname.match(/^\/logs\/([a-z]+)$/);
      if (logsMatch && req.method === 'GET') {
        return sendJson(res, 200, await opsVm.logsTail(logsMatch[1], url.searchParams.get('lines')));
      }

      const serviceMatch = pathname.match(/^\/service\/([a-z]+)\/(restart|start|stop|destroy)$/);
      if (serviceMatch && req.method === 'POST') {
        const [, name, action] = serviceMatch;

        if (!opsVm.isManaged(name)) {
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
