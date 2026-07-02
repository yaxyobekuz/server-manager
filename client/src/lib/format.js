export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatRate(bytesPerSec) {
  if (!bytesPerSec) return '0 KB/s';
  const kb = bytesPerSec / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : kb.toFixed(0)} KB/s`;
  return `${(kb / 1024).toFixed(1)} MB/s`;
}

export function formatMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en', { month: 'short', year: 'numeric' });
}

export function formatUptime(startMs) {
  if (!startMs) return '—';
  const s = Math.floor((Date.now() - startMs) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export const DEPLOY_STATUS = {
  none: { label: 'Not deployed', color: 'text-muted', dot: 'bg-muted', bg: 'bg-line border-line' },
  building: { label: 'Building', color: 'text-warn', dot: 'bg-warn', bg: 'bg-warn/10 border-warn/30' },
  deploying: { label: 'Deploying', color: 'text-brand', dot: 'bg-brand', bg: 'bg-brand/10 border-brand/30' },
  success: { label: 'Active', color: 'text-ok', dot: 'bg-ok', bg: 'bg-ok/10 border-ok/30' },
  failed: { label: 'Failed', color: 'text-danger', dot: 'bg-danger', bg: 'bg-danger/10 border-danger/30' },
  crashed: { label: 'Crashed', color: 'text-danger', dot: 'bg-danger', bg: 'bg-danger/10 border-danger/30' },
  removed: { label: 'Removed', color: 'text-muted', dot: 'bg-muted', bg: 'bg-line border-line' },
};

export const PM2_STATUS = {
  online: { label: 'Online', color: 'text-ok', dot: 'bg-ok' },
  stopped: { label: 'Stopped', color: 'text-danger', dot: 'bg-danger' },
  errored: { label: 'Errored', color: 'text-danger', dot: 'bg-danger' },
  launching: { label: 'Launching', color: 'text-warn', dot: 'bg-warn' },
};
