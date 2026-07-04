import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { formatBytes, formatMonth } from '../../lib/format.js';
import { Icon } from '../Icons.jsx';
import Chart from '../Chart.jsx';

/**
 * Metrics for static services (React/Vite panels served by nginx, no pm2):
 * HTTP traffic through the service's domains — requests, bandwidth, status
 * codes, top paths — plus per-domain health probes and folder disk usage.
 * Live = last 60 minutes (per minute); months = persisted hourly history.
 */
const VIOLET = '#a26bff';
const GREEN = '#29ad72';

const sum = (arr, k) => arr.reduce((a, p) => a + (p[k] || 0), 0);
const fmtCount = (v) => {
  const n = Math.round(+v);
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
};
const fmtTimeLive = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const fmtTimeMonth = (t, long) => {
  if (!t) return '';
  const d = new Date(t);
  const dm = d.toLocaleDateString('en', { day: 'numeric', month: 'short' });
  const hm = `${String(d.getHours()).padStart(2, '0')}:00`;
  return long ? `${dm}, ${hm}` : `${dm} ${hm}`;
};

export default function StaticMetricsTab({ service }) {
  const [period, setPeriod] = useState('live');
  const [data, setData] = useState(null); // /traffic payload
  const [monthPts, setMonthPts] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.traffic(service.id).then((d) => alive && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [service.id]);

  useEffect(() => {
    if (period === 'live') { setMonthPts(null); return; }
    api.trafficMonth(service.id, period).then((d) => setMonthPts(d.points || [])).catch(() => setMonthPts([]));
  }, [service.id, period]);

  const isLive = period === 'live';
  const months = data?.months || [];
  const pts = (isLive ? data?.points : monthPts) || [];
  const fmtT = isLive ? fmtTimeLive : fmtTimeMonth;
  const bucketLabel = isLive ? 'per minute' : 'per hour';

  const totalReq = sum(pts, 'req');
  const totalBytes = sum(pts, 'bytes');
  const errors = sum(pts, 's4') + sum(pts, 's5');
  const errPct = totalReq ? (errors / totalReq) * 100 : 0;

  const reqSeries = [{ name: 'requests', color: VIOLET, points: pts.map((p) => ({ t: p.t, v: p.req })) }];
  const bwSeries = [{ name: 'sent', color: GREEN, points: pts.map((p) => ({ t: p.t, v: p.bytes })) }];

  const statuses = [
    { key: 's2', label: '2xx success', dot: 'bg-ok', color: 'text-ok' },
    { key: 's3', label: '3xx redirect', dot: 'bg-muted', color: 'text-gray-300' },
    { key: 's4', label: '4xx client error', dot: 'bg-warn', color: 'text-warn' },
    { key: 's5', label: '5xx server error', dot: 'bg-danger', color: 'text-danger' },
  ].map((s) => ({ ...s, count: sum(pts, s.key) }));

  const periodLabel = isLive ? 'Live — last 60 minutes' : `${formatMonth(period)} — hourly history`;
  const noDomains = data && (!data.hosts || data.hosts.length === 0);

  return (
    <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-5 items-start">
      {/* ------------------------------------------------ narrow sidebar */}
      <aside className="card p-3 sticky top-40">
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
      </aside>

      {/* -------------------------------------------------- main column */}
      <div className="space-y-5 min-w-0">
        {/* top bar: domain health probes */}
        <div className="card px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap min-w-0">
            {(data?.probes || []).map((p) => {
              const ok = p.code >= 200 && p.code < 400;
              return (
                <span key={p.host} className={`chip ${ok ? 'bg-ok/10 border-ok/30 text-ok' : 'bg-danger/10 border-danger/30 text-danger'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-ok' : 'bg-danger'}`} />
                  {p.host} · {p.code || 'down'}
                </span>
              );
            })}
            {noDomains && <span className="text-xs text-muted">No domains attached — attach one in the Domains tab to collect traffic.</span>}
          </div>
          <span className="chip bg-bg-hover border-line text-gray-300 shrink-0">{periodLabel}</span>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-5">
          <StatCard
            icon={<Icon.globe width={15} height={15} />}
            title="Requests"
            value={fmtCount(totalReq)}
            sub={isLive ? `${(totalReq / 60).toFixed(1)} req/min avg` : `${pts.length} h recorded`}
            accent="text-brand"
          />
          <StatCard
            icon={<Icon.rocket width={15} height={15} />}
            title="Bandwidth out"
            value={formatBytes(totalBytes)}
            sub={isLive ? 'last 60 minutes' : 'total for the month'}
            accent="text-ok"
          />
          <StatCard
            icon={<Icon.list width={15} height={15} />}
            title="Errors"
            value={fmtCount(errors)}
            sub={`${errPct < 0.1 && errPct > 0 ? '<0.1' : errPct.toFixed(1)}% of requests`}
            accent={errors ? 'text-danger' : undefined}
          />
          <StatCard
            icon={<Icon.box width={15} height={15} />}
            title="Disk"
            value={formatBytes(data?.serviceDisk?.used)}
            sub={data?.serviceDisk?.path || '—'}
          />
        </div>

        {/* charts: wide requests | narrow bandwidth */}
        <div className="grid grid-cols-[2fr_1fr] gap-5">
          <ChartCard title="Requests" hint={bucketLabel}>
            <Chart series={reqSeries} formatY={fmtCount} formatT={fmtT} />
          </ChartCard>
          <ChartCard title="Bandwidth out" hint={bucketLabel}>
            <Chart series={bwSeries} formatY={formatBytes} formatT={fmtT} />
          </ChartCard>
        </div>

        {/* status mix | top paths */}
        <div className="grid grid-cols-[1fr_2fr] gap-5">
          <div className="card p-5">
            <div className="text-sm text-gray-300 mb-4">Status codes</div>
            <div className="space-y-3">
              {statuses.map((s) => (
                <div key={s.key} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-gray-300">
                    <span className={`w-2 h-2 rounded-full ${s.dot}`} /> {s.label}
                  </span>
                  <span className={`font-mono ${s.count ? s.color : 'text-muted'}`}>
                    {fmtCount(s.count)}
                    <span className="text-muted ml-2 text-xs">
                      {totalReq ? `${((s.count / totalReq) * 100).toFixed(0)}%` : '0%'}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-5 min-w-0">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-gray-300">Top paths</span>
              <span className="text-[11px] text-muted">current hour (live data)</span>
            </div>
            {(data?.topPaths || []).length === 0 ? (
              <div className="h-24 flex items-center justify-center text-xs text-muted">
                No requests recorded this hour yet.
              </div>
            ) : (
              <div className="space-y-2">
                {data.topPaths.map((p) => {
                  const maxReq = data.topPaths[0]?.req || 1;
                  return (
                    <div key={p.path}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-mono text-gray-300 truncate" title={p.path}>{p.path}</span>
                        <span className="text-muted font-mono shrink-0 ml-3">{fmtCount(p.req)} · {formatBytes(p.bytes)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-bg-input overflow-hidden">
                        <div className="h-full rounded-full bg-brand/70" style={{ width: `${Math.max(2, (p.req / maxReq) * 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
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
      {sub && <div className="text-xs text-muted mt-1 truncate">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, hint, children }) {
  return (
    <div className="card p-5 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-gray-300">{title}</div>
        <div className="text-[11px] text-muted">{hint}</div>
      </div>
      {children}
    </div>
  );
}
