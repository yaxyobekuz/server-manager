import express from 'express';
import cors from 'cors';
import compression from 'compression';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { login, requireAuth, verifyToken } from './auth.js';
import { bus } from './services/bus.js';
import { streamLogs } from './services/logs.js';
import * as metrics from './services/metrics.js';
import * as traffic from './services/traffic.js';
import * as store from './store.js';
import { serviceEnv } from './services/deploy.js';
import { openTerminal } from './services/terminal.js';

import projectRoutes from './routes/projects.js';
import serviceRoutes from './routes/services.js';
import systemRoutes from './routes/system.js';
import githubRoutes from './routes/github.js';

// Last-resort safety net: never let a stray async error from a child process
// or library (e.g. pm2 IPC) take the whole platform down. We log and continue.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.stack || err);
});

const app = express();
app.use(cors());
app.use(compression());
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// --- Public ---------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.post('/api/login', (req, res) => {
  const result = login(req.body?.password || '');
  if (!result.ok) return res.status(401).json({ error: result.error });
  res.json({ token: result.token });
});
app.use('/api/github', githubRoutes); // auth'd by HMAC

// --- Protected ------------------------------------------------------------
app.use('/api/projects', requireAuth, projectRoutes);
app.use('/api/services', requireAuth, serviceRoutes);
app.use('/api/system', requireAuth, systemRoutes);

// --- Serve built client ---------------------------------------------------
if (fs.existsSync(config.clientDist)) {
  app.use(express.static(config.clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(config.clientDist, 'index.html'));
  });
}

const server = http.createServer(app);

// --- Metrics sampler: poll pm2 every 2s to build history ------------------
setInterval(() => {
  metrics.sampleOnce().catch(() => {});
}, 2000);

// --- Traffic collector: tail per-domain nginx logs every 60s --------------
setTimeout(() => traffic.collectTick(), 3000); // establish offsets early
setInterval(() => {
  try {
    traffic.collectTick();
  } catch {
    /* one bad tick must not stop collection */
  }
}, 60000);

// --- WebSocket ------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (!verifyToken(url.searchParams.get('token'))) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  let logChild = null;
  let metricsTimer = null;
  let term = null;

  const send = (type, data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
  };

  // Forward all deploy events; the client filters by serviceId/deploymentId.
  const onDeployLog = (e) => send('deploy-log', e);
  const onDeployStatus = (e) => send('deploy-status', e);
  bus.on('deploy-log', onDeployLog);
  bus.on('deploy-status', onDeployStatus);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.action === 'logs:subscribe' && msg.pm2Name) {
      logChild?.kill();
      // event = { stream: 'out'|'err'|'sys', line }
      logChild = streamLogs(msg.pm2Name, (e) => send('log', { pm2Name: msg.pm2Name, ...e }));
    }
    if (msg.action === 'logs:unsubscribe') {
      logChild?.kill();
      logChild = null;
    }

    // Live metrics for the dashboard / service metrics tab.
    if (msg.action === 'metrics:start') {
      clearInterval(metricsTimer);
      const tick = async () => {
        try {
          send('metrics', { processes: await metrics.sampleOnce(), system: metrics.systemStats() });
        } catch {
          /* ignore */
        }
      };
      tick();
      metricsTimer = setInterval(tick, 2000);
    }
    if (msg.action === 'metrics:stop') {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }

    // Interactive shell in the service's folder, with the service's env
    // (same substitutions as a deploy — panel-only secrets stripped).
    if (msg.action === 'term:start' && msg.serviceId) {
      term?.kill();
      term = null;
      const service = store.getService(msg.serviceId);
      const base = service?.localPath || '';
      const withRoot = service?.rootDirectory ? path.join(base, service.rootDirectory) : base;
      const dir = base && fs.existsSync(withRoot) ? withRoot : base && fs.existsSync(base) ? base : null;
      if (!service || !dir) {
        send('term:data', { data: 'No folder on the VPS for this service yet — deploy it first.\r\n' });
        send('term:exit', {});
      } else {
        term = openTerminal(
          { cwd: dir, env: serviceEnv(service), cols: msg.cols, rows: msg.rows },
          (data) => send('term:data', { data }),
          (code) => {
            send('term:exit', { code });
            term = null;
          }
        );
      }
    }
    if (msg.action === 'term:input') term?.write(String(msg.data ?? ''));
    if (msg.action === 'term:resize') term?.resize(msg.cols, msg.rows);
    if (msg.action === 'term:stop') {
      term?.kill();
      term = null;
    }
  });

  ws.on('close', () => {
    logChild?.kill();
    term?.kill();
    clearInterval(metricsTimer);
    bus.off('deploy-log', onDeployLog);
    bus.off('deploy-status', onDeployStatus);
  });
});

server.listen(config.port, () => {
  console.log(`[server-manager] listening on http://127.0.0.1:${config.port}`);
});
