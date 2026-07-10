import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Rcfile that pins the shell inside SM_SCOPE (see term-rc.sh).
const RC_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'term-rc.sh');

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
 */

const clamp = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function openTerminal({ cwd, env = process.env, cols, rows }, onData, onExit) {
  const c = clamp(cols, 20, 500, 80);
  const r = clamp(rows, 5, 200, 24);
  let scope = cwd;
  try {
    scope = fs.realpathSync(cwd); // the guard compares physical paths
  } catch {
    /* keep as-is */
  }
  const child = spawn(
    'script',
    ['-qfc', `stty cols ${c} rows ${r} 2>/dev/null; exec bash --rcfile '${RC_FILE}' -i`, '/dev/null'],
    { cwd, env: { ...env, TERM: 'xterm-256color', SM_SCOPE: scope } }
  );
  child.stdout.on('data', (d) => onData(d.toString('utf8')));
  child.stderr.on('data', (d) => onData(d.toString('utf8')));
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
