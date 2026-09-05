'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createOpsVm, isManaged, MANAGED_SERVICES } = require('../lib/ops-vm');

test('isManaged rejects anything outside the fleet whitelist', () => {
  assert.equal(isManaged('vault'), true);
  assert.equal(isManaged('hub'), true);
  assert.equal(isManaged('ops'), false); // never manages itself
  assert.equal(isManaged('; rm -rf /'), false);
  assert.equal(isManaged('unknown-service'), false);
});

test('MANAGED_SERVICES is exactly the 7 fleet engines, ops excluded', () => {
  assert.deepEqual(MANAGED_SERVICES.slice().sort(), ['circle', 'hub', 'media', 'pulse', 'scope', 'spark', 'vault']);
});

test('serviceAction refuses an unmanaged service before ever touching child_process', async () => {
  const opsVm = createOpsVm({ composeFile: '/nonexistent.yml', reposDir: '/nonexistent' });
  const r = await opsVm.serviceAction('not-a-real-service', 'destroy');
  assert.equal(r.ok, false);
  assert.match(r.error, /not a managed service/);
});

test('logsTail refuses an unmanaged service name', async () => {
  const opsVm = createOpsVm({ composeFile: '/nonexistent.yml', reposDir: '/nonexistent' });
  const r = await opsVm.logsTail('not-a-real-service');
  assert.equal(r.ok, false);
});

test('vmStats returns real host numbers (cpuCount, memory, uptime)', async () => {
  const opsVm = createOpsVm({ composeFile: '/nonexistent.yml', reposDir: '/nonexistent' });
  const stats = await opsVm.vmStats();
  assert.ok(stats.cpuCount >= 1);
  assert.ok(stats.memTotalBytes > 0);
  assert.ok(stats.uptimeSeconds >= 0);
});

test('status reports one entry per managed service without crashing, whatever containers this host happens to have', async () => {
  const opsVm = createOpsVm({ composeFile: '/nonexistent.yml', reposDir: '/nonexistent' });
  const { services } = await opsVm.status();
  assert.equal(services.length, MANAGED_SERVICES.length);
  for (const s of services) assert.equal(typeof s.running, 'boolean');
});
