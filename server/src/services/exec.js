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
      env: { ...process.env, ...(options.env || {}) },
      shell: options.shell || false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + err.message });
    });

    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (options.timeout) {
      setTimeout(() => child.kill('SIGKILL'), options.timeout);
    }
  });
}

/**
 * Stream a command's output line by line via a callback.
 * Useful for long deploys where the UI shows live logs.
 * Returns a promise resolving to the final exit code.
 */
export function runStream(command, args = [], options = {}, onLine) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      shell: options.shell || false,
    });

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
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}
