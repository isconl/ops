'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withTmpDataDir(fn) {
  const dir = path.join(os.tmpdir(), `ops-metrics-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const prev = process.env.OPS_METRICS_DIR;
  process.env.OPS_METRICS_DIR = dir;
  delete require.cache[require.resolve('../lib/metrics')];
  const mod = require('../lib/metrics');
  try {
    return fn(mod, dir);
  } finally {
    if (prev === undefined) delete process.env.OPS_METRICS_DIR; else process.env.OPS_METRICS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('sampleOnce skips a machine that is not controllable -- no fabricated numbers', async () => {
  await withTmpDataDir(async ({ createMetricsCollector }) => {
    const listMachines = async () => ({ machines: [{ id: 'm1', controllable: false }] });
    const opsVmFor = () => ({ vmStats: async () => { throw new Error('must never be called'); } });
    const c = createMetricsCollector({ listMachines, opsVmFor });
    await c.sampleOnce();
    assert.deepEqual(c.history('m1'), []);
  });
});

test('sampleOnce records a real sample for a controllable machine with a working vm', async () => {
  await withTmpDataDir(async ({ createMetricsCollector }) => {
    const listMachines = async () => ({ machines: [{ id: 'm1', controllable: true }] });
    const opsVmFor = () => ({
      vmStats: async () => ({ cpuCount: 4, loadAvg1: 0.5, memUsedPct: 42.1, disk: { usedPct: '60%' }, uptimeSeconds: 3600 }),
    });
    const c = createMetricsCollector({ listMachines, opsVmFor });
    await c.sampleOnce();
    const h = c.history('m1');
    assert.equal(h.length, 1);
    assert.equal(h[0].cpuCount, 4);
    assert.equal(h[0].memUsedPct, 42.1);
    assert.equal(h[0].diskUsedPct, 60);
    assert.equal(typeof h[0].t, 'number');
  });
});

test('sampleOnce skips a controllable machine when opsVmFor returns null', async () => {
  await withTmpDataDir(async ({ createMetricsCollector }) => {
    const listMachines = async () => ({ machines: [{ id: 'm1', controllable: true }] });
    const opsVmFor = () => null;
    const c = createMetricsCollector({ listMachines, opsVmFor });
    await c.sampleOnce();
    assert.deepEqual(c.history('m1'), []);
  });
});

test('a vmStats() rejection for one machine does not stop sampling others', async () => {
  await withTmpDataDir(async ({ createMetricsCollector }) => {
    const listMachines = async () => ({
      machines: [{ id: 'bad', controllable: true }, { id: 'good', controllable: true }],
    });
    const opsVmFor = (id) => ({
      vmStats: async () => {
        if (id === 'bad') throw new Error('boom');
        return { cpuCount: 2, loadAvg1: 0.1, memUsedPct: 10, disk: null, uptimeSeconds: 10 };
      },
    });
    const c = createMetricsCollector({ listMachines, opsVmFor });
    await c.sampleOnce();
    assert.deepEqual(c.history('bad'), []);
    assert.equal(c.history('good').length, 1);
  });
});

test('the ring buffer caps at RING_SLOTS, dropping the oldest sample first', async () => {
  await withTmpDataDir(async ({ createMetricsCollector, RING_SLOTS }) => {
    const listMachines = async () => ({ machines: [{ id: 'm1', controllable: true }] });
    let n = 0;
    const opsVmFor = () => ({
      vmStats: async () => ({ cpuCount: 1, loadAvg1: n++, memUsedPct: 1, disk: null, uptimeSeconds: 1 }),
    });
    const c = createMetricsCollector({ listMachines, opsVmFor });
    for (let i = 0; i < RING_SLOTS + 5; i++) await c.sampleOnce();
    const h = c.history('m1');
    assert.equal(h.length, RING_SLOTS);
    assert.equal(h[0].loadAvg1, 5); // the first 5 pushed were dropped
  });
});

test('hydrateFromDisk loads persisted NDJSON samples and dedupes by timestamp', async () => {
  await withTmpDataDir(async ({ createMetricsCollector }) => {
    const listMachines = async () => ({ machines: [{ id: 'm1', controllable: true }] });
    const opsVmFor = () => ({
      vmStats: async () => ({ cpuCount: 1, loadAvg1: 0, memUsedPct: 1, disk: null, uptimeSeconds: 1 }),
    });
    const c1 = createMetricsCollector({ listMachines, opsVmFor });
    await c1.sampleOnce();
    const persisted = c1.history('m1');
    assert.equal(persisted.length, 1);

    // A fresh collector (simulating a restart) starts with an empty ring
    // until hydrated from the NDJSON the first collector wrote.
    const c2 = createMetricsCollector({ listMachines, opsVmFor });
    assert.deepEqual(c2.history('m1'), []);
    c2.hydrateFromDisk('m1');
    assert.equal(c2.history('m1').length, 1);
    assert.equal(c2.history('m1')[0].t, persisted[0].t);

    // Re-hydrating must not duplicate the same sample.
    c2.hydrateFromDisk('m1');
    assert.equal(c2.history('m1').length, 1);
  });
});
