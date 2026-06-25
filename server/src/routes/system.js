import { Router } from 'express';
import * as metrics from '../services/metrics.js';
import * as pm2 from '../services/pm2.js';

const router = Router();

router.get('/stats', (req, res) => {
  res.json({ system: metrics.systemStats() });
});

// All pm2 processes on the box (used by the global "Processes" view).
router.get('/processes', async (req, res) => {
  try {
    res.json({ processes: await pm2.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/processes/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  try {
    if (action === 'restart') await pm2.restart(id);
    else if (action === 'stop') await pm2.stop(id);
    else if (action === 'start') await pm2.start(id);
    else return res.status(400).json({ error: 'Unknown action' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
