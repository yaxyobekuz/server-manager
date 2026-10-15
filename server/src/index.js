import express from 'express';
import cors from 'cors';
import compression from 'compression';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { login, requireAuth, requireOwner, verifyToken, authFrom, can, canProject } from './auth.js';
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
import adminRoutes from './routes/admins.js';

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
// Who am I + what may I do — the client builds its navigation and hides
// forbidden controls from this (the server still enforces every route).
app.get('/api/me', requireAuth, (req, res) => res.json({ me: req.auth }));
app.use('/api/projects', requireAuth, projectRoutes);
app.use('/api/services', requireAuth, serviceRoutes);
app.use('/api/system', requireAuth, systemRoutes);
app.use('/api/admins', requireAuth, requireOwner, adminRoutes);

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
  const auth = authFrom(verifyToken(url.searchParams.get('token')));
  if (!auth) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  let logChild = null;
  let metricsTimer = null;
  let term = null;

  const send = (type, data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
  };

  // Project access per serviceId, memoized — deploy logs fire per line and
  // must not hit the db file every time.
  const accessCache = new Map();
  const canSeeService = (serviceId) => {
    if (auth.role === 'owner') return true;
    if (!accessCache.has(serviceId)) {
      const svc = store.getService(serviceId);
      accessCache.set(serviceId, svc ? canProject(auth, svc.projectId) : false);
    }
    return accessCache.get(serviceId);
  };

  // Forward deploy events the viewer is allowed to see; the client further
  // filters by serviceId/deploymentId.
  const onDeployLog = (e) => canSeeService(e.serviceId) && send('deploy-log', e);
  const onDeployStatus = (e) => canSeeService(e.serviceId) && send('deploy-status', e);
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
      const svc = store.findServiceByPm2Name(msg.pm2Name);
      const allowed = svc
        ? can(auth, 'logs') && canProject(auth, svc.projectId)
        : can(auth, 'processes'); // unmanaged process → Processes-level access
      if (!allowed) {
        send('log', { pm2Name: msg.pm2Name, stream: 'sys', line: 'Permission denied: logs' });
        return;
      }
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
      if (!can(auth, 'metrics')) return;
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

    // Interactive shell. With serviceId it starts in that service's folder
    // with the service's env (same substitutions as a deploy — panel-only
    // secrets stripped); without it, a general shell at the projects root.
    if (msg.action === 'term:start') {
      if (!can(auth, 'terminal') || (msg.serviceId && !canSeeService(msg.serviceId))) {
        send('term:data', { data: 'Permission denied: terminal\r\n' });
        send('term:exit', {});
        return;
      }
      term?.kill();
      term = null;
      let dir = config.projectsRoot;
      let env = serviceEnv({}); // process.env minus the panel's own secrets
      if (msg.serviceId) {
        const service = store.getService(msg.serviceId);
        const base = service?.localPath || '';
        const withRoot = service?.rootDirectory ? path.join(base, service.rootDirectory) : base;
        dir = base && fs.existsSync(withRoot) ? withRoot : base && fs.existsSync(base) ? base : null;
        if (!service || !dir) {
          send('term:data', { data: 'No folder on the VPS for this service yet — deploy it first.\r\n' });
          send('term:exit', {});
        } else {
          env = serviceEnv(service);
        }
      }
      if (dir) {
        term = openTerminal(
          { cwd: dir, env, cols: msg.cols, rows: msg.rows },
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

// Deployments interrupted by the previous panel process must not show
// "Building…" forever.
const orphaned = store.failOrphanedDeployments();
if (orphaned) console.log(`[server-manager] marked ${orphaned} interrupted deployment(s) as failed`);

server.listen(config.port, () => {
  console.log(`[server-manager] listening on http://127.0.0.1:${config.port}`);
});
