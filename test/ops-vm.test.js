'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createOpsVm, parseComposeConfig, groupBy } = require('../lib/ops-vm');

// BI26091401: the managed set used to be a hardcoded array. These tests
// cover the pure discovery logic (parseComposeConfig/groupBy) directly,
// with no real `docker` binary needed -- the same reasoning BI26091301's
// discoverProjects tests already used: separate the discovery/grouping
// logic from the live process call so it's testable without the real
// dependency (there, GitHub; here, docker).

test('parseComposeConfig extracts each service\'s ops.group label, excludes "ops" itself', () => {
  const raw = JSON.stringify({
    services: {
      vault: { labels: { 'ops.group': 'iSconl' } },
      hub: { labels: { 'ops.group': 'iSconl' } },
      'qspace-press': { labels: { 'ops.group': 'qpress' } },
      ops: { labels: { 'ops.group': 'iSconl' } }, // must never appear in output
    },
  });
  const { discoveryOk, services } = parseComposeConfig(raw);
  assert.equal(discoveryOk, true);
  assert.equal(services.length, 3);
  assert.ok(!services.some(s => s.name === 'ops'), 'ops excludes itself unconditionally');
  assert.deepEqual(services.find(s => s.name === 'vault'), { name: 'vault', group: 'iSconl' });
  assert.deepEqual(services.find(s => s.name === 'qspace-press'), { name: 'qspace-press', group: 'qpress' });
});

test('parseComposeConfig reports a service with no ops.group label as group:null, not a guessed default', () => {
  const raw = JSON.stringify({ services: { aquifer: { labels: {} }, aria: {} } });
  const { services } = parseComposeConfig(raw);
  assert.deepEqual(services.find(s => s.name === 'aquifer'), { name: 'aquifer', group: null });
  assert.deepEqual(services.find(s => s.name === 'aria'), { name: 'aria', group: null });
});

test('parseComposeConfig reports discoveryOk:false on unparsable input, rather than throwing', () => {
  const { discoveryOk, discoveryError, services } = parseComposeConfig('not json');
  assert.equal(discoveryOk, false);
  assert.ok(discoveryError);
  assert.deepEqual(services, []);
});

test('groupBy buckets by group and keeps ungrouped items separate, never folding them into a default group', () => {
  const items = [
    { name: 'vault', group: 'iSconl' },
    { name: 'hub', group: 'iSconl' },
    { name: 'qspace-press', group: 'qpress' },
    { name: 'aquifer', group: null },
  ];
  const { groups, ungrouped } = groupBy(items);
  assert.equal(groups.iSconl.length, 2);
  assert.equal(groups.qpress.length, 1);
  assert.equal(ungrouped.length, 1);
  assert.equal(ungrouped[0].name, 'aquifer');
  assert.ok(!('null' in groups), 'no group literally named "null"');
});

test('isManaged rejects an unmanaged name, and anything, when discovery itself cannot run', async () => {
  const opsVm = createOpsVm({ composeFile: '/nonexistent.yml', reposDir: '/nonexistent' });
  assert.equal(await opsVm.isManaged('vault'), false);
  assert.equal(await opsVm.isManaged('; rm -rf /'), false);
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

test('status reports discoveryOk:false with no services, rather than crashing, when the compose file cannot be read', async () => {
  const opsVm = createOpsVm({ composeFile: '/nonexistent.yml', reposDir: '/nonexistent' });
  const { services, groups, ungrouped, discoveryOk, discoveryError } = await opsVm.status();
  assert.equal(discoveryOk, false);
  assert.ok(discoveryError);
  assert.deepEqual(services, []);
  assert.deepEqual(groups, {});
  assert.deepEqual(ungrouped, []);
});

test('status resolves containers via the compose service name, not a hardcoded container_name guess (FI26091401 regression)', () => {
  // A compose-file change that drops/renames an explicit `container_name`
  // (e.g. the 12 Sep qspace-* services addition) must not make a managed
  // service silently read as absent while `docker compose logs <service>`
  // keeps working. Assert the source itself, since there is no live
  // compose file to exercise the real resolver against from this machine.
  const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/ops-vm.js'), 'utf8');
  assert.match(src, /compose\(\['ps', '-q', name\]\)/, 'containerState must resolve via `docker compose ps -q <service>`');
  assert.doesNotMatch(src, /docker'.*'inspect', `isconl-\$\{name\}`/, 'containerState must not hardcode an `isconl-<name>` container name');
});

test('the managed set is no longer a literal in the source -- discovery reads docker compose config, not a hardcoded array (BI26091401 regression)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/ops-vm.js'), 'utf8');
  assert.doesNotMatch(src, /MANAGED_SERVICES\s*=\s*\[/, 'no fixed service-name array should exist');
  assert.match(src, /compose\(\['config', '--format', 'json'\]\)/, 'discovery must call `docker compose config`');
  assert.match(src, /labels\[OPS_LABEL\]/, 'group must come from each service\'s own compose label, not a hardcoded map');
});
