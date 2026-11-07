import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createSocket } from '../../api/socket.js';
import { copyText } from '../../lib/clipboard.js';
import { Icon } from '../Icons.jsx';

/**
 * Interactive shell. With a `service` prop it starts in that service's folder
 * with the service's environment variables loaded (the same env a deploy runs
 * with); without one it is a general server shell starting at /var/www.
 *
 * The shell lives on the server and outlives this socket: when the WebSocket
 * drops — which it does, because proxies close idle connections — the client
 * reconnects and re-attaches to the same shell, and the output produced while
 * it was away is replayed. Leaving the page still ends the shell.
 *
 * Copying needs help: xterm draws its own selection, so it is not a DOM
 * selection and the browser's own copy does nothing with it. The selection is
 * read out of xterm and written to the clipboard explicitly.
 */
export default function TerminalTab({ service }) {
  const boxRef = useRef(null);
  const termRef = useRef(null);
  const sessionRef = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [hasSelection, setHasSelection] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exited, setExited] = useState(false);
  const restartRef = useRef(null);
  const copyRef = useRef(null);

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
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(boxRef.current);
    fit.fit();

    // Ctrl+Shift+C (Cmd+C on a Mac) copies. Plain Ctrl+C copies only while
    // something is selected and then clears the selection, so pressing it
    // again sends the interrupt the shell expects.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.code !== 'KeyC' && e.key !== 'c' && e.key !== 'C') return true;
      if ((e.ctrlKey && e.shiftKey) || (e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        copyRef.current?.();
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && term.hasSelection()) {
        e.preventDefault();
        copyRef.current?.();
        term.clearSelection();
        return false;
      }
      return true;
    });

    const selSub = term.onSelectionChange(() => setHasSelection(term.hasSelection()));
    const note = (text) => term.write(`\r\n\x1b[90m── ${text} ──\x1b[0m\r\n`);

    const startMsg = () => ({
      action: 'term:start',
      ...(service ? { serviceId: service.id } : {}),
      cols: term.cols,
      rows: term.rows,
    });

    const socket = createSocket(
      (msg) => {
        if (msg.type === 'term:data') term.write(msg.data);
        if (msg.type === 'term:session') {
          sessionRef.current = msg.sessionId;
          setExited(false);
          if (msg.resumed) note('reconnected to the same shell');
        }
        if (msg.type === 'term:gone') {
          // The shell we were attached to is really gone (it was idle too
          // long, or the panel restarted). Start a fresh one rather than
          // leaving a terminal that looks alive and answers nothing.
          sessionRef.current = null;
          note(`previous shell is gone (${msg.reason}) — starting a new one`);
          socket.send(startMsg());
        }
        if (msg.type === 'term:exit') {
          sessionRef.current = null;
          setExited(true);
          note('shell exited');
        }
      },
      {
        // Runs on first connect and on every reconnect.
        onOpen: () => {
          if (sessionRef.current) {
            socket.send({
              action: 'term:attach',
              sessionId: sessionRef.current,
              cols: term.cols,
              rows: term.rows,
            });
          } else {
            socket.send(startMsg());
          }
        },
        onStatus: setStatus,
      }
    );

    restartRef.current = () => {
      sessionRef.current = null;
      setExited(false);
      term.clear();
      socket.send(startMsg());
    };

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
      selSub.dispose();
      restartRef.current = null;
      termRef.current = null;
      socket.send({ action: 'term:stop' }); // leaving the page ends the shell
      socket.close();
      term.dispose();
    };
  }, [service?.id]);

  // Shared by the Copy button and the keyboard shortcuts, which live inside
  // the effect and reach it through the ref.
  const copyNow = async () => {
    const sel = termRef.current?.getSelection();
    if (!sel) return;
    if (await copyText(sel)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };
  copyRef.current = copyNow;

  const dir = !service
    ? '/var/www'
    : service.rootDirectory
      ? `${service.localPath || ''}/${service.rootDirectory}`.replace(/\/{2,}/g, '/')
      : service.localPath;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 h-11 border-b border-line">
        <span className="text-sm text-gray-300 flex items-center gap-2 shrink-0">
          <Icon.terminal width={15} height={15} /> Terminal
          {status === 'closed' && (
            <span className="text-[11px] text-warn flex items-center gap-1.5" title="The connection dropped — the shell is still running and will be picked up again">
              <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse-dot" /> reconnecting
            </span>
          )}
        </span>

        <div className="flex items-center gap-2 min-w-0">
          {exited && (
            <button onClick={() => restartRef.current?.()} className="btn-ghost text-xs py-1">
              <Icon.restart width={13} height={13} /> New shell
            </button>
          )}
          <button
            onClick={copyNow}
            disabled={!hasSelection}
            title={
              hasSelection
                ? 'Copy the selected text'
                : 'Select text with the mouse first, then copy (or press Ctrl+C with a selection)'
            }
            className={`text-xs px-2.5 py-1 rounded-lg border transition flex items-center gap-1.5 shrink-0 ${
              copied
                ? 'border-ok/50 text-ok bg-ok/10'
                : hasSelection
                  ? 'border-line text-gray-300 hover:text-white hover:border-gray-500'
                  : 'border-line/60 text-muted/60 cursor-not-allowed'
            }`}
          >
            {copied ? <Icon.check width={13} height={13} /> : <Icon.copy width={13} height={13} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <span className="text-[11px] text-muted font-mono truncate hidden sm:block">
            starts in {dir || '—'}
            {service ? ' · service env loaded' : ''}
          </span>
        </div>
      </div>
      <div ref={boxRef} className="h-[65vh] min-h-[320px] bg-[#0b0d12] p-3" />
    </div>
  );
}
