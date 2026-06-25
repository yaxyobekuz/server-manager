import { spawn } from 'node:child_process';

/**
 * Stream PM2 logs for a process by shelling out to `pm2 logs <name> --raw`.
 * This avoids parsing PM2's internal log file paths and works for any process.
 * Returns the child so the caller can kill it when the client disconnects.
 */
export function streamLogs(idOrName, onLine) {
  const child = spawn(
    'pm2',
    ['logs', String(idOrName), '--raw', '--lines', '50'],
    { shell: false }
  );

  const emit = (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.length) onLine(line);
    }
  };

  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  child.on('error', (err) => onLine(`[logs error] ${err.message}`));

  return child;
}
