import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { createSocket } from '../api/socket.js';
import { Icon } from '../components/Icons.jsx';
import Chart from '../components/Chart.jsx';
import { formatBytes, formatRate, formatMonth, formatUptime, PM2_STATUS } from '../lib/format.js';

/**
 * Server-wide statistics: live + monthly history for CPU, RAM, disk and
 * bandwidth, a per-process breakdown and a storage breakdown of /var/www.
 * Chart series colors are CVD-validated against the card surface:
 * violet #a26bff (CPU / out) and green #29ad72 (RAM / in).
 */
const VIOLET = '#a26bff';
const VIOLET_DIM = '#7a4fd1';
const GREEN = '#29ad72';
const GREEN_DIM = '#1e8a5f';

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const min0 = (a) => (a.length ? Math.min(...a) : 0);
const max0 = (a) => (a.length ? Math.max(...a) : 0);
const last = (a) => (a.length ? a[a.length - 1] : null);

const fmtCpu = (v) => `${(+v).toFixed(1)}%`;
const fmtTimeLive = (t) => (t ? new Date(t).toLocaleTimeString() : '');
const fmtTimeMonth = (t, long) => {
  if (!t) return '';
  const d = new Date(t);
  const dm = d.toLocaleDateString('en', { day: 'numeric', month: 'short' });
  const hm = `${String(d.getHours()).padStart(2, '0')}:00`;
  return long ? `${dm}, ${hm}` : `${dm} ${hm}`;
};
const fmtBootUptime = (sec) => {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const loadCpuPct = (sys) => (sys ? Math.min(100, (sys.load[0] / (sys.cpus || 1)) * 100) : 0);

export default function Statistics() {
  const [ov, setOv] = useState(null); // /system/overview payload
  const [sysNow, setSysNow] = useState(null); // freshest system stats (WS)
  const [win, setWin] = useState([]); // live window [{t,cpu,mem,rx,tx}]
  const [liveProc, setLiveProc] = useState({}); // name -> {cpu, memory}
  const [period, setPeriod] = useState('live');
  const [monthSys, setMonthSys] = useState(null); // hourly system points
  const [storage, setStorage] = useState(null);
  const seededRef = useRef(false);

  // Overview snapshot (processes, months, counts) — refreshed every 30s.
  useEffect(() => {
    const load = () =>
      api.systemOverview().then((d) => {
        setOv(d);
        setSysNow((prev) => prev || d.system);
        if (!seededRef.current && d.window?.length) {
          setWin(d.window);
          seededRef.current = true;
        }
      }).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  // Storage scan — first response may be pending, then it's cached server-side.
  useEffect(() => {
    let alive = true;
    let timer;
    const poll = () =>
      api.systemStorage().then((d) => {
        if (!alive) return;
        setStorage(d);
        timer = setTimeout(poll, d.pending ? 4000 : 60000);
      }).catch(() => { timer = setTimeout(poll, 15000); });
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  // Live stream: 2s system + per-process samples.
  useEffect(() => {
    const socket = createSocket((msg) => {
      if (msg.type !== 'metrics') return;
      if (msg.system) {
        setSysNow(msg.system);
        setWin((prev) => [
          ...prev.slice(-59),
          {
            t: Date.now(),
            cpu: +loadCpuPct(msg.system).toFixed(1),
            mem: msg.system.memory?.used || 0,
            rx: msg.system.net?.rxSec || 0,
            tx: msg.system.net?.txSec || 0,
          },
        ]);
      }
      if (msg.processes) {
        setLiveProc(Object.fromEntries(msg.processes.map((p) => [p.name, p])));
      }
    });
    socket.send({ action: 'metrics:start' });
    return () => { socket.send({ action: 'metrics:stop' }); socket.close(); };
  }, []);

  // Selected month's persisted hourly aggregates.
  useEffect(() => {
    if (period === 'live') { setMonthSys(null); return; }
    api.systemHistory(period).then((d) => setMonthSys(d.system || [])).catch(() => setMonthSys([]));
  }, [period]);

  const isLive = period === 'live';
  const sys = sysNow || ov?.system;
  const months = ov?.months || [];
  const pts = monthSys || [];
  const fmtT = isLive ? fmtTimeLive : fmtTimeMonth;

  /* ---- chart series ---- */
  const cpuSeries = isLive
    ? [{ name: 'CPU', color: VIOLET, points: win.map((p) => ({ t: p.t, v: p.cpu })) }]
    : [
        { name: 'avg', color: VIOLET, points: pts.map((p) => ({ t: p.t, v: p.cpu })) },
        { name: 'peak', color: VIOLET_DIM, dash: true, points: pts.map((p) => ({ t: p.t, v: p.cpuMax ?? p.cpu })) },
      ];
  const memSeries = isLive
    ? [{ name: 'RAM', color: GREEN, points: win.map((p) => ({ t: p.t, v: p.mem })) }]
    : [
        { name: 'avg', color: GREEN, points: pts.map((p) => ({ t: p.t, v: p.mem })) },
        { name: 'peak', color: GREEN_DIM, dash: true, points: pts.map((p) => ({ t: p.t, v: p.memMax ?? p.mem })) },
      ];
  const netSeries = isLive
    ? [
        { name: 'in', color: GREEN, points: win.map((p) => ({ t: p.t, v: p.rx })) },
        { name: 'out', color: VIOLET, points: win.map((p) => ({ t: p.t, v: p.tx })) },
      ]
    : [
        { name: 'in (avg)', color: GREEN, points: pts.map((p) => ({ t: p.t, v: p.rx || 0 })) },
        { name: 'out (avg)', color: VIOLET, points: pts.map((p) => ({ t: p.t, v: p.tx || 0 })) },
      ];
  const diskPts = pts.filter((p) => p.disk);
  const diskSeries = [{ name: 'used', color: VIOLET, points: diskPts.map((p) => ({ t: p.t, v: p.disk.used })) }];

  /* ---- exact numbers ---- */
  const cpuVals = isLive ? win.map((p) => p.cpu) : pts.map((p) => p.cpu);
  const memVals = isLive ? win.map((p) => p.mem) : pts.map((p) => p.mem);
  const cpuPeak = isLive ? max0(cpuVals) : max0(pts.map((p) => p.cpuMax ?? p.cpu));
  const memPeak = isLive ? max0(memVals) : max0(pts.map((p) => p.memMax ?? p.mem));
  const cpuHead = isLive ? loadCpuPct(sys) : avg(cpuVals);
  const memHead = isLive ? sys?.memory?.used || 0 : avg(memVals);

  const disk = isLive ? sys?.disk : last(diskPts)?.disk || sys?.disk;
  const diskPct = disk?.total ? (disk.used / disk.total) * 100 : 0;
  const memPct = sys?.memory?.total ? (memHead / sys.memory.total) * 100 : 0;

  // Month totals: hourly average rates -> bytes = rate * 3600.
  const totalIn = pts.reduce((a, p) => a + (p.rx || 0) * 3600, 0);
  const totalOut = pts.reduce((a, p) => a + (p.tx || 0) * 3600, 0);

  const summary = ov?.summary;
  const managed = ov?.managed || {};
  const periodLabel = isLive ? 'Live — last 2 minutes' : `${formatMonth(period)} — hourly history`;

  // Live cpu/mem overlaid on the 30s process snapshot; online first, big first.
  const procs = useMemo(() => {
    const rows = (ov?.processes || []).map((p) => ({
      ...p,
      cpu: liveProc[p.name]?.cpu ?? p.cpu,
      memory: liveProc[p.name]?.memory ?? p.memory,
    }));
    return rows.sort((a, b) =>
      (a.status === 'online' ? 0 : 1) - (b.status === 'online' ? 0 : 1) || b.memory - a.memory
    );
  }, [ov, liveProc]);

  return (
    <div className="min-h-full bg-grid-fade">
      <header className="flex items-center justify-between px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <h1 className="text-[15px] font-semibold text-white">Server statistics</h1>
        <span className="flex items-center gap-2 text-xs text-ok">
          <span className="w-2 h-2 rounded-full bg-ok animate-pulse-dot" /> Live
        </span>
      </header>

      <div className="p-8">
        <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-5 items-start">
          {/* ------------------------------------------------ period sidebar */}
          <aside className="card p-3 sticky top-20">
            <div className="text-[11px] text-muted uppercase tracking-wide px-2 mb-2">Period</div>
            <PeriodButton active={isLive} onClick={() => setPeriod('live')}>
              <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-ok animate-pulse-dot' : 'bg-muted'}`} />
              Live
            </PeriodButton>
            {months.map((m) => (
              <PeriodButton key={m} active={period === m} onClick={() => setPeriod(m)}>
                <Icon.list width={12} height={12} className="opacity-60" />
                {formatMonth(m)}
              </PeriodButton>
            ))}
            {!months.length && <p className="text-[11px] text-muted px-2 mt-1">History appears within an hour of running.</p>}
          </aside>

          {/* -------------------------------------------------- main column */}
          <div className="space-y-5 min-w-0">
            {/* top bar */}
            <div className="card px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3 min-w-0" title={ov?.system?.cpuModel || ''}>
                <span className="w-2 h-2 rounded-full bg-ok shrink-0" />
                <span className="text-sm text-white font-mono truncate">{sys?.hostname || '…'}</span>
                <span className="text-xs text-muted">
                  {sys?.platform} · {sys?.cpus} cores · node {sys?.nodeVersion || ov?.system?.nodeVersion || ''}
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted shrink-0">
                <span>Uptime <span className="text-gray-200">{fmtBootUptime(sys?.uptime)}</span></span>
                <span>Load <span className="text-gray-200 font-mono">{(sys?.load || []).map((l) => l.toFixed(2)).join(' / ')}</span></span>
                {summary && (
                  <span className={`chip ${summary.errored ? 'bg-danger/10 border-danger/30 text-danger' : 'bg-bg-hover border-line text-gray-300'}`}>
                    {summary.online}/{summary.total} processes online{summary.errored ? ` · ${summary.errored} errored` : ''}
                  </span>
                )}
                <span className="chip bg-bg-hover border-line text-gray-300">{periodLabel}</span>
              </div>
            </div>

            {/* KPI row */}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-5">
              <StatCard
                icon={<Icon.cpu width={15} height={15} />}
                title={isLive ? 'CPU' : 'CPU (avg)'}
                value={fmtCpu(cpuHead)}
                sub={isLive ? `peak ${fmtCpu(cpuPeak)} · ${sys?.cpus || '—'} cores` : `peak ${fmtCpu(cpuPeak)}`}
                accent="text-brand"
              />
              <StatCard
                icon={<Icon.box width={15} height={15} />}
                title={isLive ? 'RAM' : 'RAM (avg)'}
                value={formatBytes(memHead)}
                sub={`of ${formatBytes(sys?.memory?.total)} (${memPct.toFixed(0)}%)`}
                accent="text-ok"
              />
              <StatCard
                icon={<Icon.list width={15} height={15} />}
                title="Disk"
                value={formatBytes(disk?.used)}
                sub={`of ${formatBytes(disk?.total)} · ${formatBytes(disk?.free)} free`}
              />
              <StatCard
                icon={<Icon.globe width={15} height={15} />}
                title={isLive ? 'Network' : 'Network (month)'}
                value={isLive ? `↓ ${formatRate(sys?.net?.rxSec)}` : `↓ ${formatBytes(totalIn)}`}
                sub={isLive ? `↑ ${formatRate(sys?.net?.txSec)}` : `↑ ${formatBytes(totalOut)}`}
              />
            </div>

            {/* charts: wide cpu | narrow ram */}
            <div className="grid grid-cols-[2fr_1fr] gap-5">
              <ChartCard
                title="CPU usage (server)"
                hint={isLive ? 'live, 2s' : <LegendPair a={{ color: VIOLET, label: 'avg' }} b={{ color: VIOLET_DIM, label: 'peak' }} />}
                stats={statLine(cpuVals, fmtCpu)}
              >
                <Chart series={cpuSeries} max={Math.max(10, Math.ceil(cpuPeak * 1.2))} formatY={fmtCpu} formatT={fmtT} />
              </ChartCard>
              <ChartCard
                title="RAM usage"
                hint={isLive ? 'live, 2s' : <LegendPair a={{ color: GREEN, label: 'avg' }} b={{ color: GREEN_DIM, label: 'peak' }} />}
                stats={statLine(memVals, formatBytes)}
              >
                <Chart series={memSeries} max={sys?.memory?.total} formatY={formatBytes} formatT={fmtT} />
              </ChartCard>
            </div>

            {/* charts: wide bandwidth | narrow disk */}
            <div className="grid grid-cols-[2fr_1fr] gap-5">
              <ChartCard
                title="Bandwidth"
                hint={
                  <span className="flex items-center gap-3">
                    <Legend color={GREEN} label={isLive ? `in ${formatRate(sys?.net?.rxSec)}` : `in total ${formatBytes(totalIn)}`} />
                    <Legend color={VIOLET} label={isLive ? `out ${formatRate(sys?.net?.txSec)}` : `out total ${formatBytes(totalOut)}`} />
                  </span>
                }
              >
                <Chart series={netSeries} formatY={formatRate} formatT={fmtT} />
              </ChartCard>

              {isLive ? (
                <div className="card p-5">
                  <div className="flex items-center gap-2 text-sm text-gray-300 mb-4">
                    <Icon.list width={15} height={15} /> Disk (server)
                  </div>
                  <div className="text-2xl font-semibold text-white">{formatBytes(disk?.used)}</div>
                  <div className="text-[11px] text-muted mt-0.5 mb-3">of {formatBytes(disk?.total)}</div>
                  <div className="h-2 rounded-full bg-bg-input border border-line overflow-hidden">
                    <div
                      className={`h-full rounded-full ${diskPct > 85 ? 'bg-danger' : diskPct > 70 ? 'bg-warn' : 'bg-brand'}`}
                      style={{ width: `${Math.min(100, diskPct)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px] text-muted mt-2">
                    <span>{diskPct.toFixed(1)}% used</span>
                    <span>{formatBytes(disk?.free)} free</span>
                  </div>
                </div>
              ) : (
                <ChartCard title="Disk used" hint="hourly snapshot">
                  <Chart series={diskSeries} max={disk?.total} formatY={formatBytes} formatT={fmtT} />
                </ChartCard>
              )}
            </div>

            {/* processes */}
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between px-5 h-12 border-b border-line">
                <span className="text-sm text-gray-300">Processes</span>
                {summary && (
                  <span className="text-[11px] text-muted">
                    {summary.online}/{summary.total} online · {formatBytes(summary.memory)} RAM · CPU {summary.cpu}%
                    {ov?.counts ? ` · ${ov.counts.projects} projects / ${ov.counts.services} services managed` : ''}
                  </span>
                )}
              </div>
              <table className="w-full text-sm">
                <thead className="text-muted text-xs uppercase">
                  <tr className="border-b border-line">
                    <th className="text-left font-medium px-5 py-2.5">name</th>
                    <th className="text-left font-medium px-4 py-2.5">status</th>
                    <th className="text-right font-medium px-4 py-2.5">cpu</th>
                    <th className="text-right font-medium px-4 py-2.5">memory</th>
                    <th className="text-right font-medium px-4 py-2.5">ram %</th>
                    <th className="text-right font-medium px-4 py-2.5">↺</th>
                    <th className="text-right font-medium px-5 py-2.5">uptime</th>
                  </tr>
                </thead>
                <tbody>
                  {procs.map((p) => {
                    const st = PM2_STATUS[p.status] || PM2_STATUS.stopped;
                    const m = managed[p.name];
                    const ramShare = sys?.memory?.total ? (p.memory / sys.memory.total) * 100 : 0;
                    return (
                      <tr key={p.id} className="border-b border-line-soft last:border-0 hover:bg-bg-hover/40">
                        <td className="px-5 py-2.5">
                          {m ? (
                            <Link to={`/projects/${m.projectId}/services/${m.serviceId}`} className="text-white font-medium hover:text-brand transition">
                              {p.name} <span className="chip bg-brand/10 border-brand/30 text-brand ml-1.5 !py-0 text-[10px]">managed</span>
                            </Link>
                          ) : (
                            <span className="text-white font-medium">{p.name}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-2"><span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} /><span className={st.color}>{st.label}</span></span>
                        </td>
                        <td className="px-4 py-2.5 text-right text-gray-300 font-mono">{p.cpu}%</td>
                        <td className="px-4 py-2.5 text-right text-gray-300 font-mono">{formatBytes(p.memory)}</td>
                        <td className="px-4 py-2.5 text-right text-muted font-mono">{ramShare < 0.1 ? '<0.1' : ramShare.toFixed(1)}%</td>
                        <td className="px-4 py-2.5 text-right text-muted font-mono">{p.restarts}</td>
                        <td className="px-5 py-2.5 text-right text-muted font-mono">{formatUptime(p.uptime)}</td>
                      </tr>
                    );
                  })}
                  {!procs.length && <tr><td colSpan={7} className="text-center text-muted py-10">No pm2 processes found.</td></tr>}
                </tbody>
              </table>
            </div>

            {/* storage breakdown */}
            <StorageCard storage={storage} disk={sys?.disk} />
          </div>
        </div>
      </div>
    </div>
  );
}

const SHOW_FOLDERS = 14;

function StorageCard({ storage, disk }) {
  const folders = storage?.folders || [];
  const top = folders.slice(0, SHOW_FOLDERS);
  const rest = folders.slice(SHOW_FOLDERS);
  const restBytes = rest.reduce((a, f) => a + f.bytes, 0);
  const maxBytes = top[0]?.bytes || 1;
  const totalBytes = folders.reduce((a, f) => a + f.bytes, 0);

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-gray-300 flex items-center gap-2">
          <Icon.box width={15} height={15} /> Storage · {storage?.root || '/var/www'}
        </span>
        <span className="text-[11px] text-muted">
          {storage?.pending
            ? 'Scanning folders… (first scan takes ~20s)'
            : `${folders.length} folders · ${formatBytes(totalBytes)} total${disk ? ` · server disk ${formatBytes(disk.used)} / ${formatBytes(disk.total)}` : ''}${storage?.refreshing ? ' · refreshing…' : ''}`}
        </span>
      </div>

      {storage?.pending ? (
        <div className="h-24 flex items-center justify-center text-xs text-muted">Measuring folder sizes…</div>
      ) : (
        <div className="space-y-2.5">
          {top.map((f) => (
            <div key={f.path}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-mono text-gray-300 truncate" title={f.path}>
                  {f.name}
                  {f.managed && <span className="chip bg-brand/10 border-brand/30 text-brand ml-2 !py-0 text-[10px]">managed</span>}
                </span>
                <span className="text-muted font-mono shrink-0 ml-3">{formatBytes(f.bytes)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-bg-input overflow-hidden">
                <div className="h-full rounded-full bg-brand/70" style={{ width: `${Math.max(1, (f.bytes / maxBytes) * 100)}%` }} />
              </div>
            </div>
          ))}
          {rest.length > 0 && (
            <div className="text-[11px] text-muted pt-1">+{rest.length} more folders · {formatBytes(restBytes)}</div>
          )}
          {!folders.length && <div className="h-16 flex items-center justify-center text-xs text-muted">No folders found.</div>}
        </div>
      )}
    </div>
  );
}

function statLine(vals, fmt) {
  if (!vals.length) return null;
  return (
    <>
      <span>min <b className="text-gray-300 font-mono font-normal">{fmt(min0(vals))}</b></span>
      <span>avg <b className="text-gray-300 font-mono font-normal">{fmt(avg(vals))}</b></span>
      <span>max <b className="text-gray-300 font-mono font-normal">{fmt(max0(vals))}</b></span>
    </>
  );
}

function PeriodButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition ${
        active ? 'bg-bg-hover text-white border border-line' : 'text-muted hover:text-gray-200'
      }`}
    >
      {children}
    </button>
  );
}

function StatCard({ icon, title, value, sub, accent }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 text-xs text-muted uppercase tracking-wide mb-2">
        {icon} {title}
      </div>
      <div className={`text-2xl font-semibold ${accent || 'text-white'}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, hint, stats, children }) {
  return (
    <div className="card p-5 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-gray-300">{title}</div>
        <div className="text-[11px] text-muted">{hint}</div>
      </div>
      {children}
      {stats && <div className="flex items-center gap-4 text-[11px] text-muted mt-3 pt-3 border-t border-line">{stats}</div>}
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function LegendPair({ a, b }) {
  return (
    <span className="flex items-center gap-3">
      <Legend color={a.color} label={a.label} />
      <Legend color={b.color} label={b.label} />
    </span>
  );
}
