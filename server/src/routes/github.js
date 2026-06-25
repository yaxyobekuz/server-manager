import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import * as store from '../store.js';
import { startDeployment } from '../services/deploy.js';

const router = Router();

function verifySignature(req) {
  if (!config.githubWebhookSecret) return false;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const hmac = crypto.createHmac('sha256', config.githubWebhookSecret);
  hmac.update(req.rawBody || Buffer.from(''));
  const expected = `sha256=${hmac.digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** GitHub push -> auto deploy the matching service (if enabled). */
router.post('/webhook', (req, res) => {
  if (!verifySignature(req)) return res.status(401).json({ error: 'Invalid signature' });

  const event = req.headers['x-github-event'];
  if (event === 'ping') return res.json({ ok: true, pong: true });
  if (event !== 'push') return res.json({ ok: true, ignored: event });

  const payload = req.body || {};
  const fullName = payload.repository?.full_name;
  const pushedBranch = (payload.ref || '').replace('refs/heads/', '');
  const head = payload.head_commit;

  const service = store.getServiceByRepo(fullName);
  if (!service) return res.json({ ok: true, message: `No service for ${fullName}` });
  if (!service.autoDeploy) return res.json({ ok: true, message: 'Auto-deploy disabled' });
  if (service.branch && pushedBranch && service.branch !== pushedBranch) {
    return res.json({ ok: true, message: `Branch ${pushedBranch} ignored` });
  }

  res.json({ ok: true, deploying: service.id });
  startDeployment(service, {
    trigger: 'github',
    commit: head ? { hash: head.id?.slice(0, 7), subject: head.message?.split('\n')[0] } : null,
  });
});

export default router;
