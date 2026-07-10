import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createSocket } from '../../api/socket.js';
import { Icon } from '../Icons.jsx';

/**
 * Interactive shell that starts in this service's folder with the service's
 * environment variables loaded (the same env a deploy runs with). One shell
 * per open tab — leaving the tab ends it; coming back starts a fresh one.
 */
export default function TerminalTab({ service }) {
  const boxRef = useRef(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: {
        background: '#0b0d12',
        foreground: '#d6dae2',
        cursor: '#a26bff',
        selectionBackground: '#3a3f4d',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(boxRef.current);
    fit.fit();

    const socket = createSocket((msg) => {
      if (msg.type === 'term:data') term.write(msg.data);
      if (msg.type === 'term:exit') {
        term.write('\r\n\x1b[90m── shell exited — switch tabs and back to start a new one ──\x1b[0m\r\n');
      }
    });
    socket.send({ action: 'term:start', serviceId: service.id, cols: term.cols, rows: term.rows });
    const sub = term.onData((data) => socket.send({ action: 'term:input', data }));

    const ro = new ResizeObserver(() => {
      fit.fit();
      socket.send({ action: 'term:resize', cols: term.cols, rows: term.rows });
    });
    ro.observe(boxRef.current);
    term.focus();

    return () => {
      ro.disconnect();
      sub.dispose();
      socket.send({ action: 'term:stop' });
      socket.close();
      term.dispose();
    };
  }, [service.id]);

  const dir = service.rootDirectory
    ? `${service.localPath || ''}/${service.rootDirectory}`.replace(/\/{2,}/g, '/')
    : service.localPath;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 h-11 border-b border-line">
        <span className="text-sm text-gray-300 flex items-center gap-2">
          <Icon.terminal width={15} height={15} /> Terminal
        </span>
        <span className="text-[11px] text-muted font-mono truncate ml-4">
          scoped to {dir || '—'} · service env loaded
        </span>
      </div>
      <div ref={boxRef} className="h-[65vh] min-h-[320px] bg-[#0b0d12] p-3" />
    </div>
  );
}
