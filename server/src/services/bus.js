import { EventEmitter } from 'node:events';

/**
 * App-wide event bus. Deployment steps emit log lines + status here; the
 * WebSocket layer forwards them to any connected client.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(200);

export function emitDeployLog(serviceId, deploymentId, payload) {
  bus.emit('deploy-log', { serviceId, deploymentId, ...payload });
}

export function emitDeployStatus(serviceId, deploymentId, status) {
  bus.emit('deploy-status', { serviceId, deploymentId, status });
}
