import { spawn } from 'node:child_process';

/**
 * Run a shell command and capture its output.
 * Returns { code, stdout, stderr }. Never throws on non-zero exit —
 * the caller decides how to react.
 */
export function run(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      // replaceEnv: use exactly this env (lets callers *remove* inherited
      // vars — a spread merge can only add/override, never delete).
      env: options.replaceEnv ?? { ...process.env, ...(options.env || {}) },
      shell: options.shell || false,
    });

    let stdout = '';
    let stderr = '';
    let timer = null;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer); // don't leak the SIGKILL timer
      resolve(result);
    };

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      finish({ code: -1, stdout, stderr: stderr + err.message });
    });
    child.on('close', (code) => {
      finish({ code: code ?? -1, stdout, stderr });
    });

    if (options.timeout) {
      timer = setTimeout(() => child.kill('SIGKILL'), options.timeout);
      timer.unref?.(); // never keep the event loop alive just for this timer
    }
  });
}

/**
 * Stream a command's output line by line via a callback.
 * Useful for long deploys where the UI shows live logs.
 * Returns a promise resolving to the final exit code.
 * Pass options.timeout (ms) to SIGKILL a hung child (e.g. a wedged pm2 call).
 */
export function runStream(command, args = [], options = {}, onLine) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.replaceEnv ?? { ...process.env, ...(options.env || {}) },
      shell: options.shell || false,
    });

    let timer = null;
    let settled = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(code);
    };

    const emit = (chunk, stream) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.length) onLine?.({ stream, line });
      }
    };

    child.stdout.on('data', (d) => emit(d, 'stdout'));
    child.stderr.on('data', (d) => emit(d, 'stderr'));
    child.on('error', (err) => {
      onLine?.({ stream: 'stderr', line: err.message });
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));

    if (options.timeout) {
      timer = setTimeout(() => {
        onLine?.({ stream: 'stderr', line: `[timed out after ${options.timeout}ms — killed]` });
        child.kill('SIGKILL');
      }, options.timeout);
      timer.unref?.();
    }
  });
}
