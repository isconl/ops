'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMachineRegistry, loadDeclaredMachines, mergeMachines, parseTsv } = require('../lib/machines');

function tmpTsv(content) {
  const file = path.join(os.tmpdir(), `ops-machines-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tsv`);
  fs.writeFileSync(file, content);
  return file;
}

test('parseTsv parses a header + rows, skipping blank lines', () => {
  const rows = parseTsv('ID\tNAME\nm1\tMachine One\n\nm2\tMachine Two\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ID: 'm1', NAME: 'Machine One' });
});

test('loadDeclaredMachines returns [] for a missing file rather than throwing', () => {
  assert.deepEqual(loadDeclaredMachines('/nonexistent/machines.tsv'), []);
});

test('loadDeclaredMachines reads real rows and expands a leading ~ in path columns', () => {
  const file = tmpTsv('ID\tNAME\tPROVIDER\tOCI_INSTANCE_ID\tCOMPOSE_FILE\tREPOS_DIR\nm1\tProd\toci\tocid1.instance.oc1..x\t~/isconl-docker/deploy/docker-compose.vm.yml\t~/isconl-docker\n');
  const machines = loadDeclaredMachines(file);
  fs.unlinkSync(file);
  assert.equal(machines.length, 1);
  assert.equal(machines[0].id, 'm1');
  assert.equal(machines[0].ociInstanceId, 'ocid1.instance.oc1..x');
  assert.ok(machines[0].composeFile.startsWith(os.homedir()));
  assert.ok(!machines[0].composeFile.includes('~'));
});

test('loadDeclaredMachines drops a row with no ID -- an unidentifiable machine is not a machine', () => {
  const file = tmpTsv('ID\tNAME\n\tNameless\n');
  const machines = loadDeclaredMachines(file);
  fs.unlinkSync(file);
  assert.equal(machines.length, 0);
});

test('mergeMachines matches a declared machine to its live OCI instance by OCI_INSTANCE_ID, and is controllable only with both composeFile and reposDir', () => {
  const declared = [{ id: 'prod', name: 'Prod', provider: 'oci', ociInstanceId: 'ocid1.instance.oc1..prod', composeFile: '/a/compose.yml', reposDir: '/a/repos' }];
  const oci = [{ id: 'ocid1.instance.oc1..prod', name: 'isconl-vault-a1', shape: 'VM.Standard.A1.Flex', lifecycleState: 'RUNNING' }];
  const merged = mergeMachines(declared, oci);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].declared, true);
  assert.equal(merged[0].controllable, true);
  assert.equal(merged[0].oci.lifecycleState, 'RUNNING');
});

test('mergeMachines lists a declared machine with no connection info as declared but NOT controllable -- fails closed', () => {
  const declared = [{ id: 'm1', name: 'M1', provider: 'oci', ociInstanceId: '', composeFile: '', reposDir: '' }];
  const merged = mergeMachines(declared, []);
  assert.equal(merged[0].declared, true);
  assert.equal(merged[0].controllable, false);
});

test('BI26091506: mergeMachines surfaces an undeclared live OCI instance -- visible, never controllable -- the row\'s whole reason to exist', () => {
  const declared = [{ id: 'prod', name: 'Prod', provider: 'oci', ociInstanceId: 'ocid1.instance.oc1..prod', composeFile: '/a', reposDir: '/b' }];
  const oci = [
    { id: 'ocid1.instance.oc1..prod', name: 'isconl-vault-a1', shape: 'VM.Standard.A1.Flex', lifecycleState: 'RUNNING' },
    { id: 'ocid1.instance.oc1..stray1', name: 'unnamed', shape: 'VM.Standard.E2.1.Micro', lifecycleState: 'RUNNING' },
    { id: 'ocid1.instance.oc1..stray2', name: 'unnamed2', shape: 'VM.Standard.E2.1.Micro', lifecycleState: 'STOPPED' },
  ];
  const merged = mergeMachines(declared, oci);
  assert.equal(merged.length, 3);
  const strays = merged.filter(m => !m.declared);
  assert.equal(strays.length, 2);
  assert.ok(strays.every(m => m.controllable === false), 'an undeclared machine must never be controllable');
  assert.ok(strays.every(m => m.oci !== null), 'an undeclared machine is still visible with its live OCI state');
});

test('createMachineRegistry.listMachines reports discoveryOk:false and declared-only machines when OCI credentials are not configured, never throwing', async () => {
  const file = tmpTsv('ID\tNAME\tPROVIDER\tOCI_INSTANCE_ID\tCOMPOSE_FILE\tREPOS_DIR\nm1\tM1\toci\t\t/a\t/b\n');
  const registry = createMachineRegistry({ machinesFile: file, ociCreds: {} });
  const { machines, discoveryOk, discoveryError } = await registry.listMachines();
  fs.unlinkSync(file);
  assert.equal(discoveryOk, false);
  assert.ok(discoveryError);
  assert.equal(machines.length, 1);
  assert.equal(machines[0].controllable, true);
});

test('createMachineRegistry.listMachines runs the live poll and merges when credentials are configured', async () => {
  const file = tmpTsv('ID\tNAME\tPROVIDER\tOCI_INSTANCE_ID\tCOMPOSE_FILE\tREPOS_DIR\nprod\tProd\toci\tocid1.instance.oc1..prod\t/a\t/b\n');
  const listInstancesImpl = async () => ({ ok: true, error: null, instances: [
    { id: 'ocid1.instance.oc1..prod', name: 'isconl-vault-a1', lifecycleState: 'RUNNING' },
    { id: 'ocid1.instance.oc1..stray', name: 'unnamed', lifecycleState: 'RUNNING' },
  ] });
  const registry = createMachineRegistry({ machinesFile: file, ociCreds: { tenancyOcid: 't', userOcid: 'u', fingerprint: 'f', region: 'r', privateKeyPem: 'k' }, listInstancesImpl });
  const { machines, discoveryOk } = await registry.listMachines();
  fs.unlinkSync(file);
  assert.equal(discoveryOk, true);
  assert.equal(machines.length, 2);
});

test('createMachineRegistry.opsVmFor returns null for a machine with no connection info, and a real ops-vm for one that has it', () => {
  const file = tmpTsv('ID\tNAME\tPROVIDER\tOCI_INSTANCE_ID\tCOMPOSE_FILE\tREPOS_DIR\nprod\tProd\toci\t\t/a/compose.yml\t/a/repos\nstray\tStray\toci\t\t\t\n');
  const registry = createMachineRegistry({ machinesFile: file, ociCreds: {} });
  const declared = registry.loadDeclaredMachines();
  const prodVm = registry.opsVmFor('prod', declared);
  const strayVm = registry.opsVmFor('stray', declared);
  const unknownVm = registry.opsVmFor('does-not-exist', declared);
  fs.unlinkSync(file);
  assert.ok(prodVm, 'a machine with a declared composeFile+reposDir must get a real ops-vm');
  assert.equal(typeof prodVm.status, 'function');
  assert.equal(strayVm, null, 'a machine with no connection info must get no ops-vm -- fail closed to read-only');
  assert.equal(unknownVm, null);
});
