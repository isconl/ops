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
  ],
};
