import { Router } from 'express';
import * as store from '../store.js';
import * as selfUpdate from '../services/selfUpdate.js';

/**
 * The panel managing itself: which commit it runs, whether the repo has
 * moved on, and the button that pulls, rebuilds and restarts it.
 *
 * Mounted owner-only. An update replaces the code that enforces every
 * permission in here, so it is not something a created admin may trigger.
 */
const router = Router();

/** Current state. Cheap and network-free — the UI polls this. */
router.get('/', async (req, res) => {
  const lines = Math.min(Math.max(Number(req.query.logLines) || 200, 0), 2000);
  try {
    res.json({
      repo: await selfUpdate.repoState(),
      settings: store.getSettings(),
      ...selfUpdate.status({ logLines: lines }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Ask the remote what is on the branch. Hits the network. */
router.get('/check', async (req, res) => {
  try {
    res.json(await selfUpdate.checkRemote());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Start an update. Answers immediately: the work happens in a detached
 * helper, and this very process is killed partway through it.
 */
router.post('/update', (req, res) => {
  const started = selfUpdate.start({ trigger: 'manual', force: Boolean(req.body?.force) });
  if (!started.ok) return res.status(409).json({ error: started.error });
  res.json(started);
});

router.patch('/settings', (req, res) => {
  const patch = {};
  if ('selfUpdateAuto' in (req.body || {})) patch.selfUpdateAuto = Boolean(req.body.selfUpdateAuto);
  res.json({ settings: store.updateSettings(patch) });
});

export default router;
