import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { createSocket } from '../../api/socket.js';
import { formatBytes, formatRate, formatMonth, formatUptime, PM2_STATUS } from '../../lib/format.js';
import { Icon } from '../Icons.jsx';
import Chart from '../Chart.jsx';

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const min0 = (arr) => (arr.length ? Math.min(...arr) : 0);
const max0 = (arr) => (arr.length ? Math.max(...arr) : 0);
const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

const fmtCpu = (v) => `${(+v).toFixed(1)}%`;
const fmtTimeLive = (t, long) => (t ? new Date(t).toLocaleTimeString() : '');
const fmtTimeMonth = (t, long) => {
  if (!t) return '';
  const d = new Date(t);
  const dm = d.toLocaleDateString('en', { day: 'numeric', month: 'short' });
  const hm = `${String(d.getHours()).padStart(2, '0')}:00`;
  return long ? `${dm}, ${hm}` : `${dm} ${hm}`;
};

export default function MetricsTab({ service }) {
  const name = service.pm2Name || service.name;
  const [period, setPeriod] = useState('live'); // 'live' | 'YYYY-MM'
  const [months, setMonths] = useState([]);
  const [live, setLive] = useState(null); // pm2 describe (status/uptime/restarts)
  const [history, setHistory] = useState([]); // live window [{t,cpu,memory}]
  const [sysNow, setSysNow] = useState(null); // live system stats (disk/net/mem)
  const [serviceDisk, setServiceDisk] = useState(null); // { path, used }
  const [netHist, setNetHist] = useState([]); // live window [{t,rx,tx}]
  const [monthData, setMonthData] = useState(null); // { points, system }
  const socketRef = useRef(null);

  // Snapshot (live window, months, per-service disk) — refreshed every 60s.
  useEffect(() => {
    const loadSnapshot = () =>
      api.metrics(service.id).then((d) => {
        setHistory(d.history || []);
        setLive((prev) => d.live || prev);
        setMonths(d.months || []);
        setSysNow((prev) => d.system || prev);
        setServiceDisk(d.serviceDisk || null);
      });
    loadSnapshot();
    const timer = setInterval(loadSnapshot, 60000);

    const socket = createSocket((msg) => {
      if (msg.type !== 'metrics') return;
      const mine = (msg.processes || []).find((p) => p.name === name);
      if (mine) {
        setLive((prev) => ({ ...(prev || {}), cpu: mine.cpu, memory: mine.memory, status: prev?.status || 'online' }));
        setHistory((prev) => [...prev.slice(-59), { t: Date.now(), cpu: mine.cpu, memory: mine.memory }]);
      }
      if (msg.system) {
        setSysNow(msg.system);
        setNetHist((prev) => [...prev.slice(-59), { t: Date.now(), rx: msg.system.net?.rxSec || 0, tx: msg.system.net?.txSec || 0 }]);
      }
    });
    socketRef.current = socket;
    socket.send({ action: 'metrics:start' });
    return () => {
      clearInterval(timer);
      socket.send({ action: 'metrics:stop' });
      socket.close();
    };
  }, [service.id]);

  // Selected month's persisted hourly aggregates.
  useEffect(() => {
    if (period === 'live') { setMonthData(null); return; }
    api.metricsMonth(service.id, period).then(setMonthData).catch(() => setMonthData({ points: [], system: [] }));
  }, [service.id, period]);

  const isLive = period === 'live';
  const points = monthData?.points || [];
  const sysPoints = monthData?.system || [];
  const fmtT = isLive ? fmtTimeLive : fmtTimeMonth;

  // ---- chart series ({t, v} points) ----
  const cpuSeries = isLive
    ? [{ name: 'CPU', color: '#a26bff', points: history.map((p) => ({ t: p.t, v: p.cpu })) }]
    : [
        { name: 'avg', color: '#a26bff', points: points.map((p) => ({ t: p.t, v: p.cpu })) },
        { name: 'peak', color: '#7a4fd1', dash: true, points: points.map((p) => ({ t: p.t, v: p.cpuMax ?? p.cpu })) },
      ];
  const memSeries = isLive
    ? [{ name: 'RAM', color: '#3ecf8e', points: history.map((p) => ({ t: p.t, v: p.memory })) }]
    : [
        { name: 'avg', color: '#3ecf8e', points: points.map((p) => ({ t: p.t, v: p.mem })) },
        { name: 'peak', color: '#2b9e6b', dash: true, points: points.map((p) => ({ t: p.t, v: p.memMax ?? p.mem })) },
      ];
  const netSeries = isLive
    ? [
        { name: 'in', color: '#3ecf8e', points: netHist.map((p) => ({ t: p.t, v: p.rx })) },
        { name: 'out', color: '#a26bff', points: netHist.map((p) => ({ t: p.t, v: p.tx })) },
      ]
    : [
        { name: 'in (avg)', color: '#3ecf8e', points: sysPoints.map((p) => ({ t: p.t, v: p.rx || 0 })) },
        { name: 'out (avg)', color: '#a26bff', points: sysPoints.map((p) => ({ t: p.t, v: p.tx || 0 })) },
      ];

  // ---- exact numbers ----
  const cpuVals = (isLive ? history.map((p) => p.cpu) : points.map((p) => p.cpu)) || [];
  const memVals = isLive ? history.map((p) => p.memory) : points.map((p) => p.mem);
  const cpuPeak = isLive ? max0(cpuVals) : max0(points.map((p) => p.cpuMax ?? p.cpu));
  const memPeak = isLive ? max0(memVals) : max0(points.map((p) => p.memMax ?? p.mem));
  const cpuNow = isLive ? live?.cpu ?? 0 : avg(cpuVals);
  const memNow = isLive ? live?.memory || 0 : avg(memVals);

  // Month totals: each point is an hourly average rate -> bytes = rate * 3600.
  const totalIn = sysPoints.reduce((a, p) => a + (p.rx || 0) * 3600, 0);
  const totalOut = sysPoints.reduce((a, p) => a + (p.tx || 0) * 3600, 0);

  const sysDisk = isLive ? sysNow?.disk : last(sysPoints)?.disk || sysNow?.disk;
  const svcShare = sysDisk?.total && serviceDisk?.used ? (serviceDisk.used / sysDisk.total) * 100 : 0;

  const st = PM2_STATUS[live?.status] || PM2_STATUS.stopped;
  const periodLabel = isLive ? 'Live — last 2 minutes' : `${formatMonth(period)} — hourly history`;

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
        {!months.length && <p className="text-[11px] text-muted px-2 mt-1">History appears within an hour of running.</p>}
      </aside>

      {/* -------------------------------------------------- main column */}
      <div className="space-y-5 min-w-0">
        {/* top bar — full width */}
        <div className="card px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
            <span className={`text-sm font-medium ${st.color}`}>{st.label}</span>
            <span className="text-sm text-white font-mono truncate">{name}</span>
          </div>
          <div className="flex items-center gap-5 text-xs text-muted shrink-0">
            <span>Uptime <span className="text-gray-200">{formatUptime(live?.uptime)}</span></span>
            <span>Restarts <span className="text-gray-200">{live?.restarts ?? 0}</span></span>
            <span className="chip bg-bg-hover border-line text-gray-300">{periodLabel}</span>
          </div>
        </div>

        {/* 3 blocks: current | cpu | ram */}
        <div className="grid grid-cols-3 gap-5">
          <StatCard
            icon={<Icon.rocket width={15} height={15} />}
            title="Current"
            value={isLive ? st.label : `${points.length} h`}
            sub={isLive ? `up ${formatUptime(live?.uptime)}` : 'hours recorded'}
            accent={st.color}
          />
          <StatCard
            icon={<Icon.cpu width={15} height={15} />}
            title={isLive ? 'CPU' : 'CPU (avg)'}
            value={fmtCpu(cpuNow)}
            sub={`peak ${fmtCpu(cpuPeak)}`}
            accent="text-brand"
          />
          <StatCard
            icon={<Icon.box width={15} height={15} />}
            title={isLive ? 'RAM' : 'RAM (avg)'}
            value={formatBytes(memNow)}
            sub={`peak ${formatBytes(memPeak)}`}
            accent="text-ok"
          />
        </div>

        {/* charts: wide ram | narrow cpu */}
        <div className="grid grid-cols-[2fr_1fr] gap-5">
          <ChartCard
            title="RAM usage"
            hint={isLive ? 'live, 2s' : 'hourly avg + peak'}
            stats={statLine(memVals, formatBytes)}
          >
            <Chart series={memSeries} formatY={formatBytes} formatT={fmtT} />
          </ChartCard>
          <ChartCard title="CPU usage" hint={isLive ? 'live, 2s' : 'hourly avg + peak'} stats={statLine(cpuVals, fmtCpu)}>
            <Chart series={cpuSeries} max={Math.max(10, Math.ceil(cpuPeak * 1.2))} formatY={fmtCpu} formatT={fmtT} />
          </ChartCard>
        </div>

        {/* resources: narrow disk | wide bandwidth */}
        <div className="grid grid-cols-[1fr_2fr] gap-5">
          <div className="card p-5">
            <div className="flex items-center gap-2 text-sm text-gray-300 mb-4">
              <Icon.box width={15} height={15} /> Disk usage (service)
            </div>
            <div className="text-2xl font-semibold text-white">{formatBytes(serviceDisk?.used)}</div>
            <div className="text-[11px] text-muted font-mono truncate mt-0.5 mb-3" title={serviceDisk?.path}>
              {serviceDisk?.path || '—'}
            </div>
            <div className="h-2 rounded-full bg-bg-input border border-line overflow-hidden">
              <div
                className="h-full rounded-full bg-brand"
                style={{ width: `${Math.max(svcShare, serviceDisk?.used ? 1.5 : 0)}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-muted mt-2">
              <span>{svcShare < 0.1 && svcShare > 0 ? '<0.1' : svcShare.toFixed(1)}% of server disk</span>
              <span>{formatBytes(sysDisk?.free)} free</span>
            </div>
          </div>

          <ChartCard
            title="Bandwidth (server)"
            hint={
              isLive ? (
                <span className="flex items-center gap-3">
                  <Legend color="#3ecf8e" label={`in ${formatRate(sysNow?.net?.rxSec)}`} />
                  <Legend color="#a26bff" label={`out ${formatRate(sysNow?.net?.txSec)}`} />
                </span>
              ) : (
                <span className="flex items-center gap-3">
                  <Legend color="#3ecf8e" label={`in total ${formatBytes(totalIn)}`} />
                  <Legend color="#a26bff" label={`out total ${formatBytes(totalOut)}`} />
                </span>
              )
            }
          >
            <Chart series={netSeries} formatY={formatRate} formatT={fmtT} />
          </ChartCard>
        </div>
      </div>
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
