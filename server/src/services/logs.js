import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe } from './pm2.js';

/**
 * Stream a service's runtime logs with the stream identity preserved:
 *   out — the app's stdout log file        (info)
 *   err — the app's stderr log file        (errors)
 *   sys — pm2 daemon events for this app   (starts, exits, restarts)
 *
 * pm2's own `pm2 logs` merges everything into one undifferentiated firehose,
 * so instead we tail the log files pm2 already writes (paths come from
 * `pm2 describe`) — that keeps out/err apart and costs one `tail -F` each.
 *
 * Returns a handle with kill(); setup is async behind the scenes.
 */
export function streamLogs(idOrName, onEvent) {
  const children = [];
  let killed = false;

  const tailFile = (file, stream, { history = 80, filter } = {}) => {
    if (killed || !file || !fs.existsSync(file)) return;
    const child = spawn('tail', ['-n', String(history), '-F', file], { shell: false });
    children.push(child);
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop(); // keep the unfinished tail for the next chunk
      for (const line of parts) {
        if (!line.length) continue;
        if (filter && !filter(line)) continue;
        onEvent({ stream, line });
      }
    });
    child.on('error', () => {});
  };

  (async () => {
    const proc = await describe(idOrName).catch(() => null);
    if (killed) return;
    if (!proc) {
      onEvent({ stream: 'sys', line: `pm2 process "${idOrName}" not found — deploy the service first.` });
      return;
    }
    tailFile(proc.outLogPath, 'out');
    tailFile(proc.errLogPath, 'err');
    // Daemon events mention the app as "[name:id]" — tail only new ones.
    tailFile(path.join(os.homedir(), '.pm2', 'pm2.log'), 'sys', {
      history: 0,
      filter: (l) => l.includes(`[${proc.name}:`) || l.includes(`app=${proc.name} `),
    });
    if (killed) for (const c of children) c.kill();
  })();

  return {
    kill() {
      killed = true;
      for (const c of children) c.kill();
    },
  };
}

/**
 * A snapshot of the last lines of a service's logs, for callers that cannot
 * hold a stream open — the HTTP API and, through it, the MCP server. Same
 * two files `streamLogs` tails, so out and err stay apart.
 */
export async function recentLogs(idOrName, { lines = 100 } = {}) {
  const proc = await describe(idOrName).catch(() => null);
  if (!proc) return { found: false, pm2Name: idOrName, out: [], err: [] };
  const n = Math.min(Math.max(Number(lines) || 100, 1), 2000);

  const tail = (file) =>
    new Promise((resolve) => {
      if (!file || !fs.existsSync(file)) return resolve([]);
      const child = spawn('tail', ['-n', String(n), file], { shell: false });
      let buf = '';
      child.stdout.on('data', (c) => {
        buf += c.toString();
      });
      child.on('error', () => resolve([]));
      child.on('close', () => resolve(buf.split('\n').filter((l) => l.length)));
    });

  const [out, err] = await Promise.all([tail(proc.outLogPath), tail(proc.errLogPath)]);
  return { found: true, pm2Name: proc.name, status: proc.status, out, err };
}
