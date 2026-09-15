'use strict';
/**
 * ops's actual VM control surface. Deliberately narrow: every state-changing
 * action is a fixed-argv `execFile` call (never a shell string), scoped to
 * whatever `docker compose config` reports for the live compose file -- a
 * leaked OPS_TOKEN can only ever restart/stop/destroy a container that
 * genuinely exists in that file via `docker compose`, never run arbitrary
 * shell on the VM (see BI26090502's own reasoning in build.md: narrower
 * blast radius than an SSH key).
 *
 * Matches the exact mechanism `deploy-staging.yml` already uses on this same
 * VM (`~/isconl-docker/deploy/docker-compose.vm.yml`, `sudo docker compose`)
 * -- nothing new to trust, just exposed as an authenticated HTTP surface
 * instead of only reachable via a GitHub Actions SSH step.
 *
 * BI26091501 (15 Sep 2026, per Sconl): the fleet used to be the only thing
 * this VM ran, so a fixed 7-name array was a reasonable stand-in for "every
 * container." That stopped being true the moment qpress/qpages/aquifer/aria
 * started arriving as their own containers on the same VM. Per Sconl's own
 * standing instruction against hardcoding data into code, the managed set
 * is no longer a literal in this file at all -- it's read live from
 * `docker compose config`, and each service's GROUP comes from its own
 * `ops.group` compose label, so a new container declares itself rather
 * than requiring an Ops code change and redeploy. A service with no
 * `ops.group` label is reported separately as ungrouped, never silently
 * dropped -- the same acceptance-guard lesson BI26091301's discovery/filter
 * split already established the same day.
 *
 * Write control is opt-in, decided the same day once grouping made the
 * question real: a container appearing in `status()` is useful on its own
 * (observable by default), but that container being one call away from
 * `destroy` purely because it happened to be discovered is a different
 * proposition nobody chose. So a service also declares whether it accepts
 * restart/stop/start/destroy, via its own `ops.control` compose label
 * (`"true"`, alongside `ops.group`) -- and the check fails CLOSED: no
 * label, or any value other than the literal string `"true"`, means
 * read-only, never assumed-controllable. `iSconl` is the one group that
 * opts in on the live VM (once its compose labels land -- see the module
 * doc's own deploy note); everything newer (qpress/qpages/aquifer/aria)
 * stays observe-only until someone deliberately turns it on. This widens
 * what Ops can SEE without quietly widening what it can DO -- the fixed-
 * argv `execFile` shape and the `destroy` confirm guard above are
 * unchanged by this, deliberately: broadening the managed/observable set
 * is not license to also broaden the action surface.
 */

const { execFile } = require('child_process');
const os = require('os');

const OPS_LABEL = 'ops.group';
const OPS_CONTROL_LABEL = 'ops.control';

/** Pure JSON-parsing step of discovery, separated out so the label/group
 *  extraction is testable without a real `docker` binary. `rawJsonText` is
 *  exactly `docker compose config --format json`'s stdout. */
function parseComposeConfig(rawJsonText) {
  let parsed;
  try { parsed = JSON.parse(rawJsonText); }
  catch { return { discoveryOk: false, discoveryError: 'could not parse docker compose config output as JSON', services: [] }; }
  const services = Object.entries(parsed.services || {})
    .filter(([name]) => name !== 'ops')
    .map(([name, def]) => ({
      name,
      group: (def.labels && def.labels[OPS_LABEL]) || null,
      // Fail closed: anything but the literal string "true" is read-only.
      // A missing/malformed/truthy-but-wrong-shaped label must never be
      // read as "controllable" by accident.
      controllable: !!(def.labels && def.labels[OPS_CONTROL_LABEL] === 'true'),
    }));
  return { discoveryOk: true, discoveryError: null, services };
}

/** Groups results into { groupName: [...] } plus a separate `ungrouped`
 *  bucket -- never folds an ungrouped service into a default group or
 *  drops it, per the row's own acceptance-guard requirement. */
function groupBy(items) {
  const groups = {};
  const ungrouped = [];
  for (const item of items) {
    if (item.group) (groups[item.group] = groups[item.group] || []).push(item);
    else ungrouped.push(item);
  }
  return { groups, ungrouped };
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

  /**
   * The single source of truth for "what does this VM run" -- everything
   * else in this module derives from this call instead of a literal list.
   * `ops` itself is the one name still excluded unconditionally: destroying/
   * stopping your own control plane from inside itself is a footgun with no
   * legitimate use case, not a grouping decision.
   *
   * Returns `discoveryOk: false` (with `discoveryError`) rather than
   * throwing when `docker compose config` itself fails -- a caller must be
   * able to tell "the compose file couldn't be read" apart from
   * "it was read and reports zero services," the same distinction
   * BI26091301's discoveredProjectCount/shownProjectCount split makes.
   */
  async function discoverServices() {
    const r = await compose(['config', '--format', 'json']);
    if (!r.ok) return { discoveryOk: false, discoveryError: r.stderr || 'docker compose config failed', services: [] };
    return parseComposeConfig(r.stdout);
  }

  async function isManaged(name) {
    const { services } = await discoverServices();
    return services.some(s => s.name === name);
  }

  /** Fails closed with everything else in this module: an unmanaged name,
   *  or discovery itself failing, reads as not-controllable, never as
   *  "assume yes." */
  async function isControllable(name) {
    const { services } = await discoverServices();
    const svc = services.find(s => s.name === name);
    return !!(svc && svc.controllable);
  }

  async function containerState(name) {
    // Resolve the container via `docker compose ps` against the SAME compose
    // service name logsTail()/deployStatus() already trust, instead of
    // guessing a fixed `isconl-${name}` container_name. The guess is what
    // broke: a compose-file change (e.g. the 12 Sep qspace-* services
    // addition) can rename or drop an explicit container_name without
    // touching the service name, and `docker inspect isconl-vault` then
    // silently 404s while `docker compose logs vault` keeps working fine.
    const idResult = await compose(['ps', '-q', name]);
    const id = idResult.ok ? idResult.stdout.split('\n')[0].trim() : '';
    if (!id) return { exists: false, running: false };
    const r = await run('docker', ['inspect', id, '--format', '{{json .State}}']);
    if (!r.ok) return { exists: false, running: false };
    try {
      const state = JSON.parse(r.stdout);
      return { exists: true, running: !!state.Running, status: state.Status, startedAt: state.StartedAt, health: state.Health ? state.Health.Status : null };
    } catch {
      return { exists: false, running: false };
    }
  }

  async function status() {
    const { discoveryOk, discoveryError, services } = await discoverServices();
    const results = await Promise.all(services.map(async (s) => ({ service: s.name, group: s.group, controllable: s.controllable, ...(await containerState(s.name)) })));
    const { groups, ungrouped } = groupBy(results);
    return { services: results, groups, ungrouped, discoveryOk, discoveryError };
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
    if (!(await isManaged(name))) return { ok: false, error: `"${name}" is not a managed service` };
    const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 2000);
    const r = await compose(['logs', '--no-color', '--tail', String(n), name]);
    return { ok: r.ok, log: r.stdout || r.stderr };
  }

  async function serviceAction(name, action) {
    if (!(await isManaged(name))) return { ok: false, error: `"${name}" is not a managed service` };
    // Observable-by-default, controllable-by-opt-in (BI26091501 follow-up,
    // per Sconl): appearing in `status()` never implies restart/stop/
    // start/destroy is allowed. A service (via its group) must declare
    // `ops.control: "true"` explicitly -- anything else, including no
    // declaration at all, is read-only. Checked here, not only in
    // server.js, so this module stays the single source of truth for what
    // a caller can actually do, the same reasoning `isManaged`'s own
    // defense-in-depth check already follows.
    if (!(await isControllable(name))) return { ok: false, error: `"${name}" is read-only -- its group has not opted into control` };
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
    const { discoveryOk, discoveryError, services } = await discoverServices();
    const results = await Promise.all(services.map(async (s) => {
      const dir = `${reposDir}/${s.name}`;
      const head = await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']);
      const date = await run('git', ['-C', dir, 'log', '-1', '--format=%cI']);
      const branch = await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      return {
        service: s.name,
        group: s.group,
        commit: head.ok ? head.stdout : null,
        committedAt: date.ok ? date.stdout : null,
        branch: branch.ok ? branch.stdout : null,
      };
    }));
    return { services: results, discoveryOk, discoveryError };
  }

  return { status, vmStats, logsTail, serviceAction, deployStatus, isManaged, isControllable, discoverServices };
}

module.exports = { createOpsVm, parseComposeConfig, groupBy };
