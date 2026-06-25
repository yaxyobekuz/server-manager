import { getToken } from './client.js';

/**
 * Thin WebSocket wrapper with auto-reconnect. Lets the UI subscribe to PM2
 * logs, deploy streams and live monitoring over a single connection.
 */
export function createSocket(onMessage) {
  let ws = null;
  let closed = false;
  let reconnectTimer = null;
  const queue = [];

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = getToken();
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);

    ws.onopen = () => {
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
      if (!closed) reconnectTimer = setTimeout(connect, 1500);
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
