import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import { formatBytes } from '../lib/format.js';

/** Full server picture: hardware, OS, network, software versions, panel
 *  counts — plus an on-demand internet speed test run from the server. */
export default function InfoPage() {
  const { data, error } = useQuery({
    queryKey: ['system-info'],
    queryFn: api.systemInfo,
    refetchInterval: 10000,
  });

  return (
    <div className="min-h-full bg-grid-fade">
      <header className="flex items-center justify-between px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <h1 className="text-[15px] font-semibold text-white">Information</h1>
        {data && (
          <span className="flex items-center gap-2 text-xs text-ok">
            <span className="w-2 h-2 rounded-full bg-ok animate-pulse-dot" /> Live
          </span>
        )}
      </header>

      <div className="p-8 space-y-6">
        {error && <p className="text-sm text-danger">{error.message}</p>}

        {data && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Uptime" value={fmtDur(data.server.uptime)} sub={data.server.hostname} />
              <StatCard
                label="Load (1m)"
                value={data.cpu.load[0].toFixed(2)}
                sub={`${data.cpu.cores} CPUs · 5m ${data.cpu.load[1].toFixed(2)} · 15m ${data.cpu.load[2].toFixed(2)}`}
              />
              <StatCard
                label="Memory"
                value={formatBytes(data.memory.used)}
                sub={`of ${formatBytes(data.memory.total)}`}
              />
              <StatCard
                label="Disk"
                value={formatBytes(rootDisk(data.disks)?.used || 0)}
                sub={`of ${formatBytes(rootDisk(data.disks)?.total || 0)}`}
              />
            </div>

            <SpeedTest colo={data.network.colo} />

            <div className="grid lg:grid-cols-2 gap-4">
              <Card title="Server">
                <Row k="Hostname" v={data.server.hostname} mono />
                <Row k="Operating system" v={data.server.os} />
                <Row k="Kernel" v={data.server.kernel} mono />
                <Row k="Architecture" v={data.server.arch} mono />
                <Row k="Timezone" v={data.server.timezone} />
                <Row k="Server time" v={new Date(data.server.time).toLocaleString()} />
                <Row k="Uptime" v={fmtDur(data.server.uptime)} />
                <Row k="Panel uptime" v={fmtDur(data.server.panelUptime)} />
              </Card>

              <Card title="CPU & memory">
                <Row k="CPU model" v={data.cpu.model} />
                <Row k="Cores" v={`${data.cpu.cores}${data.cpu.speedMHz ? ` × ${(data.cpu.speedMHz / 1000).toFixed(1)} GHz` : ''}`} />
                <Row k="Load average" v={data.cpu.load.map((l) => l.toFixed(2)).join(' / ')} mono />
                <BarRow k="RAM" used={data.memory.used} total={data.memory.total} />
                {data.memory.swap.total > 0 ? (
                  <BarRow k="Swap" used={data.memory.swap.used} total={data.memory.swap.total} />
                ) : (
                  <Row k="Swap" v="none" />
                )}
              </Card>

              <Card title="Storage">
                {data.disks.map((d) => (
                  <BarRow key={d.mount} k={d.mount} sub={d.device} used={d.used} total={d.total} />
                ))}
                {data.disks.length === 0 && <p className="text-sm text-muted">No disks detected.</p>}
              </Card>

              <Card title="Network">
                <Row k="Public IP" v={data.network.publicIp || 'unavailable'} mono />
                {data.network.colo && <Row k="Nearest Cloudflare" v={data.network.colo} mono />}
                {data.network.interfaces.map((i) => (
                  <Row key={`${i.name}-${i.address}`} k={i.name} v={i.address} mono />
                ))}
              </Card>

              <Card title="Software">
                <Row k="Node.js" v={data.software.node} mono />
                <Row k="npm" v={data.software.npm || '—'} mono />
                <Row k="pm2" v={data.software.pm2 || '—'} mono />
                <Row k="nginx" v={data.software.nginx || '—'} mono />
                <Row k="certbot" v={data.software.certbot || '—'} mono />
                <Row k="git" v={data.software.git || '—'} mono />
              </Card>

              <Card title="Panel">
                <Row k="Projects" v={data.panel.projects} />
                <Row k="Services" v={data.panel.services} />
                <Row k="pm2 processes" v={`${data.panel.pm2.online}/${data.panel.pm2.total} online`} />
                <Row k="Panel port" v={data.panel.port} mono />
                <Row k="Projects root" v={data.panel.projectsRoot} mono />
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- speed test */

const LAST_KEY = 'sm_speedtest';
const loadLast = () => {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY)) || null;
  } catch {
    return null;
  }
};

function SpeedTest({ colo }) {
  const [phase, setPhase] = useState(null); // null | 'ping' | 'download' | 'upload'
  const [result, setResult] = useState(loadLast);
  const [error, setError] = useState(null);

  const runTest = async () => {
    setError(null);
    setResult(null);
    try {
      setPhase('ping');
      const ping = await api.speedtest('ping');
      setPhase('download');
      const download = await api.speedtest('download');
      setPhase('upload');
      const upload = await api.speedtest('upload');
      const r = { ping, download, upload, at: Date.now() };
      setResult(r);
      localStorage.setItem(LAST_KEY, JSON.stringify(r));
    } catch (e) {
      setError(e.message);
    } finally {
      setPhase(null);
    }
  };

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Icon.zap className="text-warn" /> Internet speed
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Measured from this server against Cloudflare{colo ? ` (${colo})` : ''} — takes ~20 seconds.
          </p>
        </div>
        <button
          onClick={runTest}
          disabled={Boolean(phase)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-brand text-white hover:opacity-90 disabled:opacity-50 transition"
        >
          {phase ? `Testing ${phase}…` : 'Run speed test'}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
        <Metric
          label="Ping"
          active={phase === 'ping'}
          value={result?.ping ? `${result.ping.ms} ms` : null}
          sub={result?.ping ? `avg ${result.ping.avg} ms · jitter ${result.ping.jitter} ms` : null}
        />
        <Metric
          label="Download"
          active={phase === 'download'}
          value={result?.download ? fmtMbps(result.download.mbps) : null}
          sub={result?.download ? `${formatBytes(result.download.bytes)} in ${result.download.secs}s` : null}
        />
        <Metric
          label="Upload"
          active={phase === 'upload'}
          value={result?.upload ? fmtMbps(result.upload.mbps) : null}
          sub={result?.upload ? `${formatBytes(result.upload.bytes)} in ${result.upload.secs}s` : null}
        />
      </div>

      {error && <p className="text-sm text-danger mt-3">{error}</p>}
      {result?.at && !phase && (
        <p className="text-[11px] text-muted mt-3">Last test: {new Date(result.at).toLocaleString()}</p>
      )}
    </div>
  );
}

function Metric({ label, value, sub, active }) {
  return (
    <div className={`rounded-lg border p-4 ${active ? 'border-brand/50 bg-brand/5' : 'border-line bg-bg-raised/40'}`}>
      <div className="text-[11px] text-muted uppercase tracking-wide">{label}</div>
      <div className="text-xl font-semibold text-white mt-1">
        {active ? <span className="text-brand animate-pulse">measuring…</span> : value || '—'}
      </div>
      {sub && !active && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

function StatCard({ label, value, sub }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] text-muted uppercase tracking-wide">{label}</div>
      <div className="text-base font-semibold text-white mt-1 truncate">{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-white mb-3">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ k, v, mono }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted shrink-0">{k}</span>
      <span className={`text-gray-200 text-right break-all ${mono ? 'font-mono text-[13px]' : ''}`}>{v}</span>
    </div>
  );
}

function BarRow({ k, sub, used, total }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  const color = pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-brand';
  return (
    <div className="text-sm">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-muted truncate">
          {k}
          {sub && <span className="text-[11px] font-mono ml-2 opacity-60">{sub}</span>}
        </span>
        <span className="text-gray-200 shrink-0">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-line mt-1.5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const rootDisk = (disks) => disks.find((d) => d.mount === '/') || disks[0];

function fmtDur(secs) {
  if (!secs) return '—';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const fmtMbps = (mbps) => (mbps >= 1000 ? `${(mbps / 1000).toFixed(2)} Gbps` : `${mbps} Mbps`);
