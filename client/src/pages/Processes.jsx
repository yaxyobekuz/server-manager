import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { createSocket } from '../api/socket.js';
import { Icon } from '../components/Icons.jsx';
import { formatBytes, formatUptime, PM2_STATUS } from '../lib/format.js';

/** Global view of every pm2 process on the VPS (not just managed services). */
export default function Processes() {
  const [procs, setProcs] = useState([]);
  const [system, setSystem] = useState(null);
  const [busy, setBusy] = useState({});
  const socketRef = useRef(null);

  useEffect(() => {
    api.processes().then((d) => setProcs(d.processes)).catch(() => {});
    api.systemStats().then((d) => setSystem(d.system)).catch(() => {});
    const socket = createSocket((msg) => {
      if (msg.type === 'metrics') {
        if (msg.system) setSystem(msg.system);
      }
    });
    socket.send({ action: 'metrics:start' });
    socketRef.current = socket;
    const poll = setInterval(() => api.processes().then((d) => setProcs(d.processes)).catch(() => {}), 2500);
    return () => { socket.send({ action: 'metrics:stop' }); socket.close(); clearInterval(poll); };
  }, []);

  const act = async (id, action) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try { await api.processAction(id, action); }
    finally {
      const d = await api.processes();
      setProcs(d.processes);
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const online = procs.filter((p) => p.status === 'online').length;
  const totalMem = procs.reduce((s, p) => s + (p.memory || 0), 0);

  return (
    <div className="min-h-full bg-grid-fade">
      <header className="flex items-center justify-between px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <h1 className="text-[15px] font-semibold text-white">Processes</h1>
        <span className="flex items-center gap-2 text-xs text-ok">
          <span className="w-2 h-2 rounded-full bg-ok animate-pulse-dot" /> Live
        </span>
      </header>

      <div className="p-8">
        {/* System stat cards */}
        {system && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard label="Host" value={system.hostname} sub={system.platform} />
            <StatCard label="Processes" value={`${online}/${procs.length} online`} sub={`${formatBytes(totalMem)} total`} />
            <StatCard label="Memory" value={`${formatBytes(system.memory.used)}`} sub={`of ${formatBytes(system.memory.total)}`} />
            <StatCard label="Load (1m)" value={system.load[0].toFixed(2)} sub={`${system.cpus} CPUs`} />
          </div>
        )}

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-muted text-xs uppercase">
              <tr className="border-b border-line">
                <th className="text-left font-medium px-4 py-3">name</th>
                <th className="text-left font-medium px-4 py-3">status</th>
                <th className="text-right font-medium px-4 py-3">cpu</th>
                <th className="text-right font-medium px-4 py-3">memory</th>
                <th className="text-right font-medium px-4 py-3">↺</th>
                <th className="text-right font-medium px-4 py-3">uptime</th>
                <th className="text-right font-medium px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {procs.map((p) => {
                const st = PM2_STATUS[p.status] || PM2_STATUS.stopped;
                return (
                  <tr key={p.id} className="border-b border-line-soft last:border-0 hover:bg-bg-hover/40">
                    <td className="px-4 py-3 text-white font-medium">{p.name}</td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2"><span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} /><span className={st.color}>{st.label}</span></span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-300 font-mono">{p.cpu}%</td>
                    <td className="px-4 py-3 text-right text-gray-300 font-mono">{formatBytes(p.memory)}</td>
                    <td className="px-4 py-3 text-right text-muted font-mono">{p.restarts}</td>
                    <td className="px-4 py-3 text-right text-muted font-mono">{formatUptime(p.uptime)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconBtn title="Restart" disabled={busy[p.id]} onClick={() => act(p.id, 'restart')}><Icon.restart /></IconBtn>
                        {p.status === 'online'
                          ? <IconBtn title="Stop" disabled={busy[p.id]} onClick={() => act(p.id, 'stop')}><Icon.stop /></IconBtn>
                          : <IconBtn title="Start" disabled={busy[p.id]} onClick={() => act(p.id, 'start')}><Icon.play /></IconBtn>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {procs.length === 0 && (
                <tr><td colSpan={7} className="text-center text-muted py-12">No pm2 processes found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] text-muted uppercase tracking-wide">{label}</div>
      <div className="text-base font-semibold text-white mt-1 truncate">{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function IconBtn({ children, onClick, disabled, title }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      className="w-7 h-7 flex items-center justify-center rounded-md bg-bg-hover hover:bg-line text-gray-300 disabled:opacity-40 transition">
      {children}
    </button>
  );
}
