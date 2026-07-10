import { useEffect, useMemo, useRef, useState } from 'react';
import { createSocket } from '../../api/socket.js';

/**
 * Live runtime logs, split by origin and colored by severity:
 *   err stream            → error (red)
 *   out stream            → info (gray), or error/warn when the line itself
 *                           says so (many loggers write errors to stdout)
 *   sys (pm2 daemon)      → system events: starts, exits, restarts (violet)
 */
const levelOf = (e) => {
  if (e.stream === 'sys') return 'system';
  if (e.stream === 'err') return 'error';
  if (/\b(error|exception|fatal|unhandled)\b/i.test(e.line)) return 'error';
  if (/\bwarn(ing)?\b/i.test(e.line)) return 'warn';
  return 'info';
};

const LEVEL_STYLE = {
  error: 'text-danger',
  warn: 'text-warn',
  system: 'text-brand',
  info: 'text-gray-300',
};

const FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'info', label: 'Info', match: (lv) => lv === 'info' || lv === 'warn' },
  { key: 'error', label: 'Errors', match: (lv) => lv === 'error' },
  { key: 'system', label: 'System', match: (lv) => lv === 'system' },
];

const ts = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function LogsTab({ service }) {
  const [entries, setEntries] = useState([]); // { line, level, t }
  const [filter, setFilter] = useState('all');
  const boxRef = useRef(null);
  const stickToBottom = useRef(true);
  const name = service.pm2Name || service.name;

  useEffect(() => {
    const socket = createSocket((msg) => {
      if (msg.type === 'log' && msg.pm2Name === name) {
        setEntries((prev) => [
          ...prev.slice(-2000),
          { line: msg.line, level: levelOf(msg), t: ts() },
        ]);
      }
    });
    socket.send({ action: 'logs:subscribe', pm2Name: name });
    return () => { socket.send({ action: 'logs:unsubscribe' }); socket.close(); };
  }, [name]);

  // Follow the tail only while the user is already at the bottom.
  const onScroll = () => {
    const el = boxRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = boxRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries, filter]);

  const counts = useMemo(() => {
    const c = { all: entries.length, info: 0, error: 0, system: 0 };
    for (const e of entries) {
      if (e.level === 'error') c.error++;
      else if (e.level === 'system') c.system++;
      else c.info++;
    }
    return c;
  }, [entries]);

  const active = FILTERS.find((f) => f.key === filter) || FILTERS[0];
  const visible = entries.filter((e) => active.match(e.level));

  return (
    <div className="card flex flex-col h-[64vh] min-h-[440px]">
      <div className="flex items-center justify-between gap-3 px-4 h-11 border-b border-line">
        <span className="text-xs font-mono text-muted truncate">Runtime logs · {name}</span>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex bg-bg-input border border-line rounded-lg p-0.5 text-xs">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-2.5 py-1 rounded flex items-center gap-1.5 ${
                  filter === f.key ? 'bg-bg-hover text-white' : 'text-muted hover:text-gray-200'
                }`}
              >
                {f.label}
                <span className={`font-mono text-[10px] ${
                  f.key === 'error' && counts.error ? 'text-danger' : 'opacity-60'
                }`}>{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <button onClick={() => setEntries([])} className="text-xs text-muted hover:text-white">Clear</button>
        </div>
      </div>

      <div ref={boxRef} onScroll={onScroll} className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
        {visible.length === 0 ? (
          <p className="text-muted">
            {entries.length === 0 ? 'Waiting for logs…' : 'Nothing in this category yet.'}
          </p>
        ) : (
          visible.map((e, i) => (
            <div key={i} className="whitespace-pre-wrap flex gap-2">
              <span className="text-muted/60 shrink-0 select-none">{e.t}</span>
              <span className={LEVEL_STYLE[e.level]}>{e.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
