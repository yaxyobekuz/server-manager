import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/**
 * Interactive shell on a real pseudo-terminal WITHOUT native modules:
 * util-linux `script` allocates the pty and runs bash inside it, while we
 * talk to `script` itself over plain pipes. Prompt, colors and full-screen
 * apps (vim, top) all behave like a real terminal.
 *
 * Resize: we can't ioctl the pty master (script owns it), but the shell's
 * pts device is visible via /proc, and `stty -F <pts>` sets the new size
 * there — the kernel then delivers SIGWINCH to the foreground app exactly
 * like a native terminal resize.
 *
 * Sessions (further down) outlive the WebSocket that opened them. A browser
 * tab behind a proxy loses its socket regularly — an idle WebSocket is
 * closed after a minute or two by nginx, Caddy or Cloudflare — and a shell
 * sitting at a prompt is idle by definition. Tying the shell's life to one
 * socket meant every such blip silently killed whatever was running in it,
 * so the shell now survives and the reconnecting client re-attaches, with
 * the output it missed replayed.
 */

const clamp = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function openTerminal({ cwd, env = process.env, cols, rows }, onData, onExit) {
  const c = clamp(cols, 20, 500, 80);
  const r = clamp(rows, 5, 200, 24);
  const child = spawn(
    'script',
    ['-qfc', `stty cols ${c} rows ${r} 2>/dev/null; exec bash -i`, '/dev/null'],
    { cwd, env: { ...env, TERM: 'xterm-256color' } }
  );
  // One decoder for both streams: a multi-byte character split across two
  // chunks would otherwise arrive as a pair of replacement characters.
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', (d) => onData(decoder.write(d)));
  child.stderr.on('data', (d) => onData(decoder.write(d)));
  child.on('exit', (code) => onExit?.(code));
  child.on('error', (e) => {
    onData(`\r\n[terminal error: ${e.message}]\r\n`);
    onExit?.(-1);
  });

  const ptsPath = () => {
    try {
      const kids = fs
        .readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')
        .trim()
        .split(/\s+/);
      for (const k of kids) {
        if (!k) continue;
        const link = fs.readlinkSync(`/proc/${k}/fd/0`);
        if (link.startsWith('/dev/pts/')) return link;
      }
    } catch {
      /* shell already gone */
    }
    return null;
  };

  return {
    write(data) {
      try {
        child.stdin.write(data);
      } catch {
        /* closed */
      }
    },
    resize(cols2, rows2) {
      const pts = ptsPath();
      if (!pts) return;
      spawn('stty', [
        '-F', pts,
        'cols', String(clamp(cols2, 20, 500, c)),
        'rows', String(clamp(rows2, 5, 200, r)),
      ]).on('error', () => {});
    },
    kill() {
      try {
        child.kill('SIGKILL'); // closing the pty master HUPs the shell
      } catch {
        /* already dead */
      }
    },
  };
}

/* -------------------------------------------------------------- sessions */

/** Output kept for replay when a client re-attaches. */
const BUFFER_MAX = 256 * 1024;
/** How long a shell with nobody watching stays alive. */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;
/** A finished shell sticks around only long enough to report how it ended. */
const EXITED_GRACE_MS = 60 * 1000;
/** Ceiling on concurrent shells, so a tab reloading in a loop cannot pile them up. */
const MAX_SESSIONS = 12;

const sessions = new Map();

/**
 * Start a shell that belongs to no socket.
 *
 * `ownerKey` decides who may attach: a session id is a capability, and
 * without the check any logged-in admin who learned an id could take over
 * someone else's shell.
 */
export function createSession({ cwd, env, cols, rows, ownerKey, label = '' }) {
  evictIfCrowded();

  const id = crypto.randomBytes(9).toString('base64url');
  const s = {
    id,
    ownerKey,
    label,
    cwd,
    createdAt: new Date().toISOString(),
    cols: clamp(cols, 20, 500, 80),
    rows: clamp(rows, 5, 200, 24),
    exited: false,
    exitCode: null,
    // Recent output plus where in the stream it starts, so a re-attach can
    // replay exactly the part the client missed.
    buf: '',
    bufStart: 0,
    total: 0,
    mark: 0, // stream position when the last client let go
    listener: null,
    reaper: null,
  };

  s.pty = openTerminal(
    { cwd, env, cols: s.cols, rows: s.rows },
    (data) => {
      if (!data) return;
      s.buf += data;
      s.total += data.length;
      if (s.buf.length > BUFFER_MAX) {
        const drop = s.buf.length - BUFFER_MAX;
        s.buf = s.buf.slice(drop);
        s.bufStart += drop;
      }
      s.listener?.({ type: 'data', data });
    },
    (code) => {
      s.exited = true;
      s.exitCode = code;
      s.listener?.({ type: 'exit', code });
      // Keep it briefly: a client reconnecting right now should be told the
      // shell ended, not that its session vanished.
      schedule(s, EXITED_GRACE_MS);
    }
  );

  sessions.set(id, s);
  return api(s);
}

/** The session, or null when it is gone or belongs to someone else. */
export function getSession(id, ownerKey) {
  const s = sessions.get(id);
  if (!s || s.ownerKey !== ownerKey) return null;
  return api(s);
}

function api(s) {
  return {
    id: s.id,
    createdAt: s.createdAt,
    cwd: s.cwd,
    label: s.label,
    get exited() {
      return s.exited;
    },
    get exitCode() {
      return s.exitCode;
    },

    /**
     * Take over the output stream and replay what the previous client did
     * not see. Returns the number of characters replayed.
     */
    attach(onEvent) {
      clearTimeout(s.reaper);
      s.reaper = null;
      s.listener = onEvent;
      const missed = s.buf.slice(Math.max(0, s.mark - s.bufStart));
      if (missed) onEvent({ type: 'data', data: missed });
      if (s.exited) onEvent({ type: 'exit', code: s.exitCode });
      return missed.length;
    },

    /** Let go without killing the shell; it waits a while for a new client. */
    detach() {
      s.listener = null;
      s.mark = s.total;
      schedule(s, s.exited ? EXITED_GRACE_MS : ORPHAN_GRACE_MS);
    },

    write(data) {
      s.pty.write(data);
    },

    resize(cols, rows) {
      s.cols = clamp(cols, 20, 500, s.cols);
      s.rows = clamp(rows, 5, 200, s.rows);
      s.pty.resize(s.cols, s.rows);
    },

    kill() {
      clearTimeout(s.reaper);
      sessions.delete(s.id);
      s.listener = null;
      s.pty.kill();
    },
  };
}

function schedule(s, ms) {
  clearTimeout(s.reaper);
  s.reaper = setTimeout(() => {
    sessions.delete(s.id);
    s.pty.kill();
  }, ms);
  s.reaper.unref?.(); // never hold the process open just to reap a shell
}

/** Make room by dropping the shell nobody has watched for the longest. */
function evictIfCrowded() {
  if (sessions.size < MAX_SESSIONS) return;
  const idle = [...sessions.values()].filter((s) => !s.listener);
  const victim = idle.sort((a, b) => a.mark - b.mark)[0] || [...sessions.values()][0];
  if (!victim) return;
  clearTimeout(victim.reaper);
  sessions.delete(victim.id);
  victim.pty.kill();
}

export const sessionCount = () => sessions.size;
