'use strict';
/**
 * ops's actual VM control surface. Deliberately narrow: every state-changing
 * action is a fixed-argv `execFile` call (never a shell string), scoped to a
 * hardcoded service whitelist -- a leaked OPS_TOKEN can only ever restart/
 * stop/destroy one of these 7 named containers via `docker compose`, never
 * run arbitrary shell on the VM (see BI26090502's own reasoning in build.md:
 * narrower blast radius than an SSH key).
 *
 * Matches the exact mechanism `deploy-staging.yml` already uses on this same
 * VM (`~/isconl-docker/deploy/docker-compose.vm.yml`, `sudo docker compose`)
 * -- nothing new to trust, just exposed as an authenticated HTTP surface
 * instead of only reachable via a GitHub Actions SSH step.
 */

const { execFile } = require('child_process');
const os = require('os');

// The 7 containers this fleet actually runs (matches docker-compose.vm.yml's
// own service list, confirmed live on the VM 5 Sep 2026). "ops" itself is
// deliberately excluded -- destroying/stopping your own control plane from
// inside itself is a footgun with no legitimate use case; ops manages the
// other 7, not itself.
const MANAGED_SERVICES = ['vault', 'pulse', 'scope', 'circle', 'spark', 'media', 'hub'];

function isManaged(name) {
  return MANAGED_SERVICES.includes(name);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    // The `ubuntu` VM user is a member of the `docker` group (confirmed live
    // 5 Sep 2026) -- every docker/docker-compose call below runs at that
    // user's own privilege, no sudo/root escalation needed or used.
    execFile(cmd, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

/**
 * @param {object} opts
 * @param {string} [opts.composeFile] - path to docker-compose.vm.yml
 * @param {string} [opts.reposDir] - parent dir holding one git checkout per service (~/isconl-docker)
 */
function createOpsVm({
  composeFile = process.env.OPS_COMPOSE_FILE || `${os.homedir()}/isconl-docker/deploy/docker-compose.vm.yml`,
  reposDir = process.env.OPS_REPOS_DIR || `${os.homedir()}/isconl-docker`,
} = {}) {

  async function compose(args) {
    return run('docker', ['compose', '-f', composeFile, ...args]);
  }

  async function containerState(name) {
    const r = await run('docker', ['inspect', `isconl-${name}`, '--format', '{{json .State}}']);
    if (!r.ok) return { exists: false, running: false };
    try {
      const state = JSON.parse(r.stdout);
      return { exists: true, running: !!state.Running, status: state.Status, startedAt: state.StartedAt, health: state.Health ? state.Health.Status : null };
    } catch {
      return { exists: false, running: false };
    }
  }

  async function status() {
    const results = await Promise.all(MANAGED_SERVICES.map(async (name) => ({ service: name, ...(await containerState(name)) })));
    return { services: results };
  }

  async function vmStats() {
    const load = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const df = await run('df', ['-h', '/']);
    let disk = null;
    if (df.ok) {
      const line = df.stdout.split('\n')[1] || '';
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5) disk = { total: cols[1], used: cols[2], available: cols[3], usedPct: cols[4] };
    }
    return {
      cpuCount: os.cpus().length,
      loadAvg1: load[0], loadAvg5: load[1], loadAvg15: load[2],
      memTotalBytes: totalMem,
      memFreeBytes: freeMem,
      memUsedPct: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
      disk,
      uptimeSeconds: os.uptime(),
    };
  }

  async function logsTail(name, lines = 200) {
    if (!isManaged(name)) return { ok: false, error: `"${name}" is not a managed service` };
    const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 2000);
    const r = await compose(['logs', '--no-color', '--tail', String(n), name]);
    return { ok: r.ok, log: r.stdout || r.stderr };
  }

  async function serviceAction(name, action) {
    if (!isManaged(name)) return { ok: false, error: `"${name}" is not a managed service` };
    // Deliberately container-level only (start/stop/restart an EXISTING
    // container) -- never `up -d`/`--build`, which could trigger an image
    // rebuild from a relative build context. A destroyed container can only
    // come back via a real redeploy (push to staging), not a "start" click.
    if (action === 'restart') return compose(['restart', name]);
    if (action === 'stop') return compose(['stop', name]);
    if (action === 'start') return compose(['start', name]);
    if (action === 'destroy') return compose(['rm', '-f', '-s', name]);
    return { ok: false, error: `unknown action "${action}"` };
  }

  async function deployStatus() {
    const results = await Promise.all(MANAGED_SERVICES.map(async (name) => {
      const dir = `${reposDir}/${name}`;
      const head = await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']);
      const date = await run('git', ['-C', dir, 'log', '-1', '--format=%cI']);
      const branch = await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      return {
        service: name,
        commit: head.ok ? head.stdout : null,
        committedAt: date.ok ? date.stdout : null,
        branch: branch.ok ? branch.stdout : null,
      };
    }));
    return { services: results };
  }

  return { status, vmStats, logsTail, serviceAction, deployStatus, isManaged, MANAGED_SERVICES };
}

module.exports = { createOpsVm, MANAGED_SERVICES, isManaged };
