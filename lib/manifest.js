'use strict';
/**
 * ops's capability manifest -- what this engine can do, for hub to
 * discover without hardcoding knowledge of ops's routes. Same shape every
 * other engine (vault/pulse/scope/circle/spark/media) already ships
 * (Decision 003).
 */
module.exports = {
  engine: 'ops',
  version: require('../package.json').version,
  description: 'Live control surface for every fleet service and the OCI VM: status, VM stats, log tail, per-service restart/start/stop/destroy, deploy status.',
  capabilities: [
    { name: 'ops.status', method: 'GET', path: '/status', description: 'Up/down + health state for every fleet service.' },
    { name: 'ops.vm.stats', method: 'GET', path: '/vm/stats', description: 'VM CPU load, memory, and disk usage.' },
    { name: 'ops.logs.tail', method: 'GET', path: '/logs/:name', description: 'Tail a service\'s container logs.' },
    { name: 'ops.service.restart', method: 'POST', path: '/service/:name/restart', description: 'Restart one service\'s container.' },
    { name: 'ops.service.start', method: 'POST', path: '/service/:name/start', description: 'Start one service\'s container.' },
    { name: 'ops.service.stop', method: 'POST', path: '/service/:name/stop', description: 'Stop one service\'s container.' },
    { name: 'ops.service.destroy', method: 'POST', path: '/service/:name/destroy', description: 'Stop and remove one service\'s container (requires a matching type-to-confirm name in the body). Image and named volumes are untouched -- the next start/deploy recreates the container.' },
    { name: 'ops.deploy.status', method: 'GET', path: '/deploy/status', description: 'Per-service running commit + last-deployed time.' },
    { name: 'ops.machines.list', method: 'GET', path: '/machines', description: 'BI26091506: every known machine -- declared config merged with a live OCI Compute API poll, so an undeclared instance in the tenancy still shows up. A machine with no declared connection info is visible but not controllable.' },
    { name: 'ops.machine.status', method: 'GET', path: '/machines/:id/status', description: 'Up/down + health state for every service on one named machine.' },
    { name: 'ops.machine.logs.tail', method: 'GET', path: '/machines/:id/logs/:name', description: 'Tail a service\'s container logs on one named machine.' },
    { name: 'ops.machine.service.restart', method: 'POST', path: '/machines/:id/service/:name/restart', description: 'Restart one service\'s container on one named machine.' },
    { name: 'ops.machine.service.start', method: 'POST', path: '/machines/:id/service/:name/start', description: 'Start one service\'s container on one named machine.' },
    { name: 'ops.machine.service.stop', method: 'POST', path: '/machines/:id/service/:name/stop', description: 'Stop one service\'s container on one named machine.' },
    { name: 'ops.machine.service.destroy', method: 'POST', path: '/machines/:id/service/:name/destroy', description: 'Stop and remove one service\'s container on one named machine (requires a matching type-to-confirm name in the body).' },
    { name: 'ops.machine.deploy.status', method: 'GET', path: '/machines/:id/deploy/status', description: 'Per-service running commit + last-deployed time on one named machine.' },
    { name: 'ops.machine.metrics.history', method: 'GET', path: '/machines/:id/metrics', description: 'BI26091904: up to 24h of 1/minute VM metric samples (cpu count, load avg, mem used %, disk used %, uptime) for one named machine. Empty for a machine that is undeclared or declared-but-not-controllable -- there is no local exec path to sample it, so it is never sampled rather than fabricated.' },
  ],
};
