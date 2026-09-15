'use strict';
/**
 * BI26091506: the machine registry. "All VMs, all platforms" means two
 * sources merged, never one guessed from the other:
 *
 *   1. A DECLARED list -- ops's own local machine config (never vault;
 *      ops has no vault dependency by design, see src/server.js's own
 *      boot-sequence comment). Each declared machine optionally carries
 *      enough connection info (composeFile/reposDir) for ops to actually
 *      run docker compose against it -- a declared machine with no
 *      connection info, or an OCI-discovered machine nobody declared at
 *      all, is visible but has no ops-vm instance, which is what makes it
 *      naturally read-only: there is no compose file to run an action
 *      against, not a separate "read-only" flag bolted on top.
 *   2. A LIVE OCI Compute API poll (lib/oci-client.js) -- so a forgotten
 *      instance nobody declared still shows up, which is the entire
 *      reason this row exists (2 undeclared `VM.Standard.E2.1.Micro`
 *      instances were already found live in the tenancy on 14 Sep).
 *
 * Matching a declared row to a live OCI instance is by OCI_INSTANCE_ID
 * (optional column) -- a declared machine with no OCI_INSTANCE_ID (e.g. a
 * future non-OCI platform) is never matched against the poll and is
 * listed purely from the declared side.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { listInstances } = require('./oci-client');
const { createOpsVm } = require('./ops-vm');

const DEFAULT_MACHINES_FILE = process.env.OPS_MACHINES_FILE || path.join(__dirname, '..', 'config', 'machines.tsv');

/** Minimal TSV parse, matching vault's own tsv.js shape closely enough for
 *  this one small config file without pulling in a dependency -- header
 *  row + tab-separated fields, blank lines skipped. */
function parseTsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const cols = line.split('\t');
    return Object.fromEntries(header.map((h, i) => [h, cols[i] !== undefined ? cols[i] : '']));
  });
}

/** `~/` at the start of a path column expands to the running user's home
 *  directory, matching ops-vm.js's own `${os.homedir()}` default paths --
 *  a checked-in machines.tsv can name a real path without hardcoding
 *  whichever user account happens to run ops. */
function expandHome(p) {
  if (!p || !p.startsWith('~')) return p;
  return path.join(os.homedir(), p.slice(1).replace(/^[/\\]/, ''));
}

/** Reads the declared-machines file. Missing file is NOT an error -- a
 *  fresh ops install with no config yet still runs, just with zero
 *  declared machines (the live OCI poll can still find everything). */
function loadDeclaredMachines(machinesFile = DEFAULT_MACHINES_FILE) {
  let text;
  try { text = fs.readFileSync(machinesFile, 'utf8'); }
  catch { return []; }
  return parseTsv(text).map(r => ({
    id: r.ID || '',
    name: r.NAME || r.ID || '',
    provider: r.PROVIDER || 'oci',
    ociInstanceId: r.OCI_INSTANCE_ID || '',
    composeFile: expandHome(r.COMPOSE_FILE || ''),
    reposDir: expandHome(r.REPOS_DIR || ''),
  })).filter(m => m.id);
}

/**
 * Pure merge, separated from the live poll so it's testable without a
 * real OCI credential or network call. `declared` from
 * loadDeclaredMachines(); `ociInstances` from oci-client's listInstances()
 * result (or [] if the poll didn't run -- see discoveryOk below).
 */
function mergeMachines(declared, ociInstances) {
  const ociById = new Map((ociInstances || []).map(i => [i.id, i]));
  const matchedOciIds = new Set();
  const merged = declared.map(m => {
    const live = m.ociInstanceId ? ociById.get(m.ociInstanceId) : null;
    if (live) matchedOciIds.add(m.ociInstanceId);
    return {
      id: m.id, name: m.name, provider: m.provider,
      declared: true,
      controllable: !!(m.composeFile && m.reposDir),
      composeFile: m.composeFile || null,
      reposDir: m.reposDir || null,
      oci: live ? { lifecycleState: live.lifecycleState, shape: live.shape, availabilityDomain: live.availabilityDomain } : null,
    };
  });
  // Undeclared: a real OCI instance nobody put in the declared file at
  // all. Visible, never controllable -- ops has no idea what's running
  // on it or how to reach it via docker compose.
  for (const inst of (ociInstances || [])) {
    if (matchedOciIds.has(inst.id)) continue;
    merged.push({
      id: inst.id, name: inst.name || inst.id, provider: 'oci',
      declared: false, controllable: false, composeFile: null, reposDir: null,
      oci: { lifecycleState: inst.lifecycleState, shape: inst.shape, availabilityDomain: inst.availabilityDomain },
    });
  }
  return merged;
}

/**
 * @param {object} opts
 * @param {string} [opts.machinesFile] - path to the declared-machines TSV
 * @param {object} [opts.ociCreds] - {tenancyOcid, userOcid, fingerprint, region, privateKeyPem, compartmentId} -- omit any field to skip the live poll entirely (declared-only mode, e.g. local dev)
 */
function createMachineRegistry({ machinesFile = DEFAULT_MACHINES_FILE, ociCreds = {}, listInstancesImpl = listInstances } = {}) {
  const opsVmCache = new Map();

  async function listMachines() {
    const declared = loadDeclaredMachines(machinesFile);
    const haveOciCreds = ociCreds.tenancyOcid && ociCreds.userOcid && ociCreds.fingerprint && ociCreds.region && ociCreds.privateKeyPem;
    if (!haveOciCreds) {
      return { machines: mergeMachines(declared, []), discoveryOk: false, discoveryError: 'OCI credentials not configured -- declared machines only' };
    }
    const r = await listInstancesImpl(ociCreds);
    return { machines: mergeMachines(declared, r.instances), discoveryOk: r.ok, discoveryError: r.error };
  }

  /** The ops-vm instance for a declared, connection-capable machine, or
   *  null for anything else -- an undeclared or connection-info-less
   *  machine has no compose file to act against, which is the fail-closed
   *  property this row asks for, not a separate flag to remember to
   *  check. Cached per machine id since createOpsVm() itself is cheap but
   *  there's no reason to rebuild it every call. */
  function opsVmFor(machineId, declaredMachines) {
    if (opsVmCache.has(machineId)) return opsVmCache.get(machineId);
    const m = (declaredMachines || loadDeclaredMachines(machinesFile)).find(x => x.id === machineId);
    if (!m || !m.composeFile || !m.reposDir) { opsVmCache.set(machineId, null); return null; }
    const vm = createOpsVm({ composeFile: m.composeFile, reposDir: m.reposDir });
    opsVmCache.set(machineId, vm);
    return vm;
  }

  return { listMachines, opsVmFor, loadDeclaredMachines: () => loadDeclaredMachines(machinesFile) };
}

module.exports = { createMachineRegistry, loadDeclaredMachines, mergeMachines, parseTsv, DEFAULT_MACHINES_FILE };
