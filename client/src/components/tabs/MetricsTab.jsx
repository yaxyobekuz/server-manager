import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { createSocket } from '../../api/socket.js';
import { formatBytes, formatUptime, PM2_STATUS } from '../../lib/format.js';
import { Icon } from '../Icons.jsx';

function Sparkline({ data, color, max }) {
  if (!data.length) return <div className="h-16 flex items-center justify-center text-xs text-muted">no data</div>;
  const w = 320, h = 64;
  const ceil = max || Math.max(...data, 1);
  const pts = data.map((v, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * w;
    const y = h - (v / ceil) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity="0.08" stroke="none" />
    </svg>
  );
}

export default function MetricsTab({ service }) {
  const [history, setHistory] = useState([]);
  const [live, setLive] = useState(null);
  const name = service.pm2Name || service.name;
  const socketRef = useRef(null);

  useEffect(() => {
    api.metrics(service.id).then((d) => { setHistory(d.history || []); setLive(d.live); });
    const socket = createSocket((msg) => {
      if (msg.type === 'metrics') {
        const mine = (msg.processes || []).find((p) => p.name === name);
        if (mine) {
          setLive((prev) => ({ ...(prev || {}), cpu: mine.cpu, memory: mine.memory, status: prev?.status || 'online' }));
          setHistory((prev) => [...prev.slice(-59), { t: Date.now(), cpu: mine.cpu, memory: mine.memory }]);
        }
      }
    });
    socketRef.current = socket;
    socket.send({ action: 'metrics:start' });
    return () => { socket.send({ action: 'metrics:stop' }); socket.close(); };
  }, [service.id]);

  const cpuSeries = history.map((p) => p.cpu);
  const memSeries = history.map((p) => p.memory / (1024 * 1024)); // MB
  const st = PM2_STATUS[live?.status] || PM2_STATUS.stopped;

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="card p-5 flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${st.dot}`} />
          <span className={`text-sm font-medium ${st.color}`}>{st.label}</span>
        </div>
        <Stat label="CPU" value={`${live?.cpu ?? 0}%`} />
        <Stat label="Memory" value={formatBytes(live?.memory || 0)} />
        <Stat label="Restarts" value={live?.restarts ?? 0} />
        <Stat label="Uptime" value={formatUptime(live?.uptime)} />
      </div>

      <div className="grid grid-cols-2 gap-5">
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3 text-sm text-gray-300"><Icon.cpu width={15} height={15} /> CPU %</div>
          <Sparkline data={cpuSeries} color="#a26bff" max={100} />
        </div>
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3 text-sm text-gray-300"><Icon.box width={15} height={15} /> Memory (MB)</div>
          <Sparkline data={memSeries} color="#3ecf8e" />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[11px] text-muted uppercase tracking-wide">{label}</div>
      <div className="text-sm font-semibold text-white mt-0.5">{value}</div>
    </div>
  );
}
