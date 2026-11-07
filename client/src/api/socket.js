import { getToken } from './client.js';

/**
 * Thin WebSocket wrapper with auto-reconnect. Lets the UI subscribe to PM2
 * logs, deploy streams, live monitoring and terminals over one connection.
 *
 * `onOpen` fires on every connect, including reconnects, and runs BEFORE the
 * queued messages are flushed — that is where a consumer re-establishes what
 * the old connection was doing (re-attach a shell, re-subscribe to logs).
 * `onStatus` reports 'open' | 'closed' so the UI can say so out loud instead
 * of looking frozen.
 */
export function createSocket(onMessage, { onOpen, onStatus } = {}) {
  let ws = null;
  let closed = false;
  let reconnectTimer = null;
  let attempt = 0;
  const queue = [];

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = getToken();
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);

    ws.onopen = () => {
      attempt = 0;
      onStatus?.('open');
      onOpen?.();
      while (queue.length) ws.send(queue.shift());
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus?.('closed');
      // Back off a little so a server that is down (a panel restart, say) is
      // not hammered, but reconnect fast enough that a blip is invisible.
      const delay = Math.min(1000 * 2 ** attempt++, 10_000);
      reconnectTimer = setTimeout(connect, delay);
    };
    ws.onerror = () => ws.close();
  }

  connect();

  return {
    send(obj) {
      const data = JSON.stringify(obj);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
      else queue.push(data);
    },
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
