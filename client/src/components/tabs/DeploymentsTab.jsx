import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { createSocket } from '../../api/socket.js';
import { Icon } from '../Icons.jsx';
import { timeAgo, DEPLOY_STATUS } from '../../lib/format.js';

/** List of deployments + a live log drawer for the selected one. */
export default function DeploymentsTab({ service, onDeployed }) {
  const queryClient = useQueryClient();
  const [chosenId, setChosenId] = useState(null);
  const [logs, setLogs] = useState([]);
  const socketRef = useRef(null);
  const logEndRef = useRef(null);

  const { data } = useQuery({
    queryKey: ['deployments', service.id],
    queryFn: () => api.deployments(service.id),
  });
  const deployments = data?.deployments || [];
  const openId = chosenId || deployments[0]?.id || null;

  // Live deploy events for this service.
  useEffect(() => {
    const socket = createSocket((msg) => {
      if (msg.serviceId !== service.id) return;
      if (msg.type === 'deploy-log') {
        setLogs((prev) => (msg.deploymentId === openId ? [...prev.slice(-2000), msg] : prev));
      }
      if (msg.type === 'deploy-status') {
        queryClient.invalidateQueries({ queryKey: ['deployments', service.id] });
        onDeployed?.();
      }
    });
    socketRef.current = socket;
    return () => socket.close();
  }, [service.id, openId]);

  // Load persisted logs when switching deployment.
  useEffect(() => {
    if (!openId) return;
    api.deployment(service.id, openId).then((d) =>
      setLogs((d.deployment.logs || []).map((l) => ({ line: l.line, stream: l.stream })))
    );
  }, [openId, service.id]);

  useEffect(() => { logEndRef.current?.scrollIntoView(); }, [logs]);

  const open = deployments.find((d) => d.id === openId);

  return (
    <div className="grid grid-cols-[280px_1fr] gap-5">
      <div className="space-y-2">
        {deployments.length === 0 && (
          <div className="card p-5 text-center text-sm text-muted">No deployments yet. Hit Deploy.</div>
        )}
        {deployments.map((d) => {
          const st = DEPLOY_STATUS[d.status] || DEPLOY_STATUS.removed;
          const active = d.id === openId;
          return (
            <button
              key={d.id}
              onClick={() => setChosenId(d.id)}
              className={`card w-full p-3.5 text-left transition ${active ? 'border-brand/50' : 'hover:border-line'}`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className={`chip ${st.bg} ${st.color}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${st.dot} ${['building', 'deploying'].includes(d.status) ? 'animate-pulse-dot' : ''}`} />
                  {st.label}
                </span>
                <span className="text-[11px] text-muted">{timeAgo(d.createdAt)}</span>
              </div>
              <p className="text-xs text-gray-300 truncate">
                {d.commit ? `${d.commit.hash} ${d.commit.subject}` : `${d.trigger} deploy`}
              </p>
            </button>
          );
        })}
      </div>

      <div className="card flex flex-col h-[60vh] min-h-[420px]">
        <div className="flex items-center justify-between px-4 h-11 border-b border-line">
          <span className="text-xs font-mono text-muted">
            {open ? `Deploy logs · ${DEPLOY_STATUS[open.status]?.label}` : 'Deploy logs'}
          </span>
        </div>
        <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
          {logs.length === 0 ? (
            <p className="text-muted">No logs.</p>
          ) : logs.map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap ${l.stream === 'stderr' ? 'text-danger/90' : 'text-gray-300'}`}>{l.line}</div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
