'use strict';
/**
 * BI26091904: in-process ring buffer + append-only NDJSON persistence for
 * per-machine VM metrics (cpu/mem/disk/load), so the ops dashboard can draw
 * small-multiple time-series charts without a new datastore or a vault
 * dependency (machines.js's own header: "ops has no vault dependency by
 * design" -- this preserves that).
 *
 * REAL CONSTRAINT, not a shortcut: `ops-vm.js`'s `vmStats()` reads `os.*`
 * (loadavg/totalmem/freemem/cpus/uptime), which is ALWAYS the local Node
 * process's own host -- it does not vary with which `composeFile`/`reposDir`
 * a `createOpsVm()` instance was built with. So a machine only gets real,
 * honest metrics here if it is declared AND controllable (i.e.
 * `machineRegistry.opsVmFor(id)` returns a working vm) -- an undeclared or
 * no-connection-info machine is never sampled, never gets a fabricated
 * number. This is the same fail-closed property `machines.js`/`server.js`
 * already apply to control actions, applied here to telemetry too.
 */

const fs = require('fs');
const path = require('path');

const RING_SLOTS = 1440; // 1/minute, 24h
const SAMPLE_INTERVAL_MS = 60 * 1000;
// Same runtime/ convention as server.js's LOGS_DIR (audit.js) -- generated
// state, not source.
const DATA_DIR = process.env.OPS_METRICS_DIR || path.join(__dirname, '..', 'runtime', 'metrics');

function todayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function ndjsonPath(machineId, d = new Date()) {
  return path.join(DATA_DIR, `metrics-${machineId}-${todayStamp(d)}.ndjson`);
}

/**
 * @param {object} opts
 * @param {() => Promise<{machines: object[]}>} opts.listMachines - from machineRegistry
 * @param {(id: string) => object|null} opts.opsVmFor - from machineRegistry
 */
function createMetricsCollector({ listMachines, opsVmFor }) {
  const rings = new Map(); // machineId -> array of {t, cpuCount, loadAvg1, memUsedPct, diskUsedPct, uptimeSeconds}
  let timer = null;

  function ringFor(machineId) {
    if (!rings.has(machineId)) rings.set(machineId, []);
    return rings.get(machineId);
  }

  function pushSample(machineId, sample) {
    const ring = ringFor(machineId);
    ring.push(sample);
    if (ring.length > RING_SLOTS) ring.shift();
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(ndjsonPath(machineId), JSON.stringify(sample) + '\n', 'utf8');
    } catch (e) {
      // A metrics write failure must never take down ops itself -- this is
      // an optional history trail, not the control surface.
      console.error(`metrics: failed to persist sample for ${machineId}: ${e.message}`);
    }
  }

  function diskUsedPct(disk) {
    if (!disk || !disk.usedPct) return null;
    const n = parseFloat(String(disk.usedPct).replace('%', ''));
    return Number.isFinite(n) ? n : null;
  }

  async function sampleOnce() {
    const { machines } = await listMachines();
    for (const m of machines) {
      if (!m.controllable) continue; // no local vmStats() path exists for this machine -- see header
      const vm = opsVmFor(m.id);
      if (!vm) continue;
      try {
        const stats = await vm.vmStats();
        pushSample(m.id, {
          t: Date.now(),
          cpuCount: stats.cpuCount,
          loadAvg1: stats.loadAvg1,
          memUsedPct: stats.memUsedPct,
          diskUsedPct: diskUsedPct(stats.disk),
          uptimeSeconds: stats.uptimeSeconds,
        });
      } catch (e) {
        console.error(`metrics: sample failed for ${m.id}: ${e.message}`);
      }
    }
  }

  /** Load today's + yesterday's NDJSON on top of whatever's in the ring,
   *  so a fresh ops restart doesn't show an empty chart for a machine that
   *  actually has history on disk -- deduped by timestamp, capped to
   *  RING_SLOTS most recent. */
  function hydrateFromDisk(machineId) {
    const files = [ndjsonPath(machineId, new Date(Date.now() - 86400000)), ndjsonPath(machineId)];
    const seen = new Set(ringFor(machineId).map(s => s.t));
    const loaded = [];
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const s = JSON.parse(line);
          if (!seen.has(s.t)) { loaded.push(s); seen.add(s.t); }
        } catch { /* one corrupt line never invalidates the rest */ }
      }
    }
    const merged = [...loaded, ...ringFor(machineId)].sort((a, b) => a.t - b.t);
    rings.set(machineId, merged.slice(-RING_SLOTS));
  }

  function history(machineId) {
    return ringFor(machineId).slice();
  }

  function start() {
    if (timer) return;
    sampleOnce();
    timer = setInterval(sampleOnce, SAMPLE_INTERVAL_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, sampleOnce, history, hydrateFromDisk };
}

module.exports = { createMetricsCollector, RING_SLOTS, SAMPLE_INTERVAL_MS };
