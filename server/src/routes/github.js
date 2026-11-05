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

  // One repo can feed several services (a copied project reuses the same
  // repoFullName), so deploy EVERY matching service, not just the first.
  const services = store.getServicesByRepo(fullName);
  if (!services.length) return res.json({ ok: true, message: `No service for ${fullName}` });

  const commit = head
    ? { hash: head.id?.slice(0, 7), subject: head.message?.split('\n')[0] }
    : null;

  const deploying = [];
  const skipped = [];
  for (const service of services) {
    if (!service.autoDeploy) {
      skipped.push({ id: service.id, reason: 'auto-deploy disabled' });
      continue;
    }
    if (service.branch && pushedBranch && service.branch !== pushedBranch) {
      skipped.push({ id: service.id, reason: `branch ${pushedBranch} ignored` });
      continue;
    }
    deploying.push(service.id);
    startDeployment(service, { trigger: 'github', commit });
  }

  res.json({ ok: true, deploying, skipped });
});

export default router;
