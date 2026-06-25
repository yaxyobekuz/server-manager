import { useEffect, useRef, useState } from 'react';
import { createSocket } from '../../api/socket.js';

/** Live runtime logs (pm2 logs <name>) for the running service. */
export default function LogsTab({ service }) {
  const [lines, setLines] = useState([]);
  const endRef = useRef(null);
  const name = service.pm2Name || service.name;

  useEffect(() => {
    const socket = createSocket((msg) => {
      if (msg.type === 'log' && msg.pm2Name === name) {
        setLines((prev) => [...prev.slice(-1000), msg.line]);
      }
    });
    socket.send({ action: 'logs:subscribe', pm2Name: name });
    return () => { socket.send({ action: 'logs:unsubscribe' }); socket.close(); };
  }, [name]);

  useEffect(() => { endRef.current?.scrollIntoView(); }, [lines]);

  return (
    <div className="card flex flex-col h-[64vh] min-h-[440px]">
      <div className="flex items-center justify-between px-4 h-11 border-b border-line">
        <span className="text-xs font-mono text-muted">Runtime logs · {name}</span>
        <button onClick={() => setLines([])} className="text-xs text-muted hover:text-white">Clear</button>
      </div>
      <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
        {lines.length === 0 ? <p className="text-muted">Waiting for logs…</p> :
          lines.map((l, i) => <div key={i} className="whitespace-pre-wrap text-gray-300">{l}</div>)}
        <div ref={endRef} />
      </div>
    </div>
  );
}
