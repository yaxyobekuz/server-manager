import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { Icon } from './Icons.jsx';

/**
 * A transfer as it happens: the step list, byte progress, the live log of
 * BOTH servers (lines coming from the other panel are prefixed with │), and
 * — when it is over — what is left for a human to do.
 *
 * The same component renders a finished transfer from the history.
 */

const DONE = ['success', 'warning', 'failed'];

const STATUS_CHIP = {
  running: { label: 'Running', cls: 'bg-brand/10 border-brand/30 text-brand' },
  success: { label: 'Done', cls: 'bg-ok/10 border-ok/30 text-ok' },
  warning: { label: 'Done · check the notes', cls: 'bg-warn/10 border-warn/30 text-warn' },
  failed: { label: 'Stopped', cls: 'bg-danger/10 border-danger/30 text-danger' },
};

function StepRow({ step }) {
  const mark =
    step.status === 'ok' ? <span className="text-ok">✓</span>
    : step.status === 'warn' ? <span className="text-warn">!</span>
    : step.status === 'fail' ? <span className="text-danger">✗</span>
    : step.status === 'skipped' ? <span className="text-muted">·</span>
    : <span className="inline-block w-2 h-2 rounded-full bg-brand animate-pulse-dot" />;
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <span className="w-4 shrink-0 text-center leading-5">{mark}</span>
      <span className="min-w-0">
        <span className={step.status === 'skipped' ? 'text-muted' : 'text-gray-200'}>
          {step.remote && <span className="text-muted mr-1" title="this step ran on the other server">│</span>}
          {step.label}
        </span>
        {step.detail && <span className="text-muted"> — {step.detail}</span>}
      </span>
    </div>
  );
}

const LOG_COLOR = {
  warn: 'text-warn',
  err: 'text-danger',
  note: 'text-gray-300',
  step: 'text-white',
};

export default function TransferJobView({ jobId, onFinished, onOpenProject }) {
  const [job, setJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState('');
  const [releasing, setReleasing] = useState(false);
  const logRef = useRef(null);
  const sinceRef = useRef(0);
  const finishedRef = useRef(false);

  useEffect(() => {
    setJob(null);
    setLogs([]);
    setError('');
    sinceRef.current = 0;
    finishedRef.current = false;
    let alive = true;
    let timer = null;

    const tick = async () => {
      try {
        const { job: snap } = await api.transferJob(jobId, sinceRef.current);
        if (!alive) return;
        if (snap.logs?.length) {
          sinceRef.current = snap.logs[snap.logs.length - 1].seq || sinceRef.current;
          setLogs((prev) => [...prev, ...snap.logs]);
        }
        setJob(snap);
        setError('');
        if (DONE.includes(snap.status)) {
          if (!finishedRef.current) {
            finishedRef.current = true;
            onFinished?.(snap);
          }
          return; // stop polling
        }
      } catch (e) {
        if (!alive) return;
        setError(e.message);
      }
      timer = setTimeout(tick, 1200);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs.length]);

  if (!job) {
    return <p className="text-sm text-muted">{error || 'Starting…'}</p>;
  }

  const chip = STATUS_CHIP[job.status] || STATUS_CHIP.running;
  const pct =
    job.progress && job.progress.total
      ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100))
      : null;

  const release = async () => {
    setReleasing(true);
    try {
      await api.transferRelease(job.id);
      const { job: snap } = await api.transferJob(job.id, 0);
      setJob(snap);
    } catch (e) {
      setError(e.message);
    } finally {
      setReleasing(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <p className="text-sm text-white truncate">
            <span className="font-semibold">{job.projectName || 'project'}</span>
            <span className="text-muted">
              {' '}
              {job.direction === 'push' ? '→' : job.direction === 'pull' ? '←' : 'from'} {job.serverName}
            </span>
          </p>
          <p className="text-xs text-muted">{job.phase}</p>
        </div>
        <span className={`chip shrink-0 ${chip.cls}`}>{chip.label}</span>
      </div>

      {pct !== null && (
        <div className="mb-4">
          <div className="flex justify-between text-xs text-muted mb-1">
            <span>{job.progress.label}</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
            <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="space-y-1.5 mb-4">
        {job.steps?.map((s) => (
          <StepRow key={s.key} step={s} />
        ))}
      </div>

      {job.error && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-3">
          <p className="text-sm text-danger whitespace-pre-wrap">{job.error}</p>
          <p className="text-xs text-muted mt-1.5">
            Nothing was deleted: the project is still on its original server, exactly as it was.
          </p>
        </div>
      )}

      {Boolean(job.warnings?.length) && (
        <div className="mb-4 rounded-lg border border-warn/30 bg-warn/5 p-3">
          <p className="text-xs font-medium text-warn mb-1.5">Worth knowing</p>
          <ul className="space-y-1">
            {job.warnings.map((w, i) => (
              <li key={i} className="text-xs text-gray-300">· {w}</li>
            ))}
          </ul>
        </div>
      )}

      {Boolean(job.notes?.length) && DONE.includes(job.status) && (
        <div className="mb-4 rounded-lg border border-line bg-bg-input p-3">
          <p className="text-xs font-medium text-gray-300 mb-1.5">What is left for you</p>
          <ul className="space-y-1">
            {job.notes.map((n, i) => (
              <li key={i} className="text-xs text-muted">· {n}</li>
            ))}
          </ul>
        </div>
      )}

      <div
        ref={logRef}
        className="rounded-lg border border-line bg-black/40 p-3 font-mono text-[11px] leading-relaxed max-h-56 overflow-y-auto"
      >
        {logs.length === 0 && <p className="text-muted">waiting for output…</p>}
        {logs.map((l) => (
          <div key={l.seq} className={`whitespace-pre-wrap ${LOG_COLOR[l.level] || 'text-gray-400'}`}>
            {l.line}
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-danger mt-2">{error}</p>}

      {(job.pendingRelease || (DONE.includes(job.status) && job.newProjectId)) && (
        <div className="flex flex-wrap items-center gap-2 mt-4">
          {job.newProjectId && onOpenProject && (
            <button onClick={() => onOpenProject(job.newProjectId)} className="btn-brand">
              <Icon.grid width={15} height={15} /> Open the project here
            </button>
          )}
          {job.pendingRelease && (
            <button onClick={release} disabled={releasing} className="btn-danger" title="Delete the project on the server it came from">
              <Icon.trash /> {releasing ? 'Removing…' : 'Remove it from the old server now'}
            </button>
          )}
        </div>
      )}
      {job.pendingRelease && (
        <p className="text-xs text-muted mt-2">
          The copy on {job.direction === 'pull' ? job.serverName : 'the other server'} was left in place because this
          transfer did not finish cleanly. Check the new copy first, then remove the old one.
        </p>
      )}
    </div>
  );
}
