import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Icon } from './Icons.jsx';
import Toggle from './Toggle.jsx';
import { timeAgo } from '../lib/format.js';

const STEPS = {
  start: 'Starting',
  fetch: 'Fetching',
  update: 'Checking out',
  install: 'Installing dependencies',
  build: 'Building',
  restart: 'Restarting',
  verify: 'Waiting for the new version',
  rollback: 'Rolling back',
  done: 'Finished',
};

/**
 * The panel deploying itself: which commit is live, what the repo has moved
 * on to, the button that pulls + rebuilds + restarts, and the switch that
 * does all of it automatically when a push lands.
 *
 * Two things make this unlike every other card: the request that starts an
 * update is answered before the work finishes (the process serving it gets
 * killed partway through), so progress is read back by polling; and when it
 * succeeds the page itself is stale, because the JavaScript running it was
 * replaced on disk — hence the reload prompt.
 */
export default function PanelUpdateCard({ enabled = true }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [reloadReady, setReloadReady] = useState(false);
  const wasRunning = useRef(false);

  const { data, error: loadError, isError } = useQuery({
    queryKey: ['panel'],
    queryFn: api.panel,
    enabled,
    // While an update runs the panel restarts under us: keep asking, and keep
    // showing the last answer we got instead of blanking the card.
    refetchInterval: (q) => (q.state.data?.job?.status === 'running' ? 1500 : 15_000),
    retry: false,
  });

  const job = data?.job || null;
  const running = job?.status === 'running';

  // A finished update left new JavaScript on disk; this page is still the old
  // bundle, so offer the reload rather than pretending nothing changed.
  useEffect(() => {
    if (running) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      if (job?.status === 'success' && job?.restarted) setReloadReady(true);
      queryClient.invalidateQueries({ queryKey: ['panelCheck'] });
    }
  }, [running, job?.status, job?.restarted, queryClient]);

  const check = useQuery({
    queryKey: ['panelCheck'],
    queryFn: api.panelCheck,
    enabled: enabled && Boolean(data) && !running,
    staleTime: 60_000,
    retry: false,
  });

  if (loadError && !data) {
    return <div className="card p-5 text-sm text-danger">Could not read the panel's state: {loadError.message}</div>;
  }
  if (!data) return <div className="card p-5 text-sm text-muted">Loading…</div>;

  const { repo, settings } = data;
  const behind = check.data?.behind ?? null;
  const tracked = repo.localChanges?.tracked || [];

  const act = async (what, fn) => {
    setError('');
    setBusy(what);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['panel'] });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  // act() invalidates ['panel'] afterwards, so the card shows the running
  // job immediately instead of waiting for the next poll.
  const update = (force) => act('update', () => api.panelUpdate(force));

  const toggleAuto = () =>
    act('auto', async () => {
      await api.panelSettings({ selfUpdateAuto: !settings.selfUpdateAuto });
    });

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Icon.rocket /> Panel updates
          </h2>
          <p className="text-xs text-muted mt-1">
            This panel deploys itself the same way it deploys everything else: fetch, hard reset, install, build,
            restart.
          </p>
        </div>
        <button
          onClick={() => check.refetch()}
          disabled={check.isFetching || running}
          className="btn-ghost shrink-0 text-xs"
        >
          <Icon.restart /> {check.isFetching ? 'Checking…' : 'Check'}
        </button>
      </div>

      {/* what is running right now */}
      <div className="mt-4 rounded-lg border border-line bg-bg-input/60 px-3 py-2.5">
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted">
          <span className="text-gray-300">Deploy v{repo.version}</span>
          <span>·</span>
          <span className="font-mono">{repo.branch}</span>
          {repo.repoFullName && (
            <>
              <span>·</span>
              <a
                href={`https://github.com/${repo.repoFullName}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono hover:text-white"
              >
                {repo.repoFullName}
              </a>
            </>
          )}
          <span>·</span>
          <span className="font-mono">pm2 {repo.pm2Name}</span>
        </div>
        <div className="mt-1.5 text-[13px] text-gray-200 flex items-baseline gap-2 flex-wrap">
          <code className="font-mono text-brand">{repo.commit.short}</code>
          <span className="min-w-0 break-words">{repo.commit.subject}</span>
          <span className="text-[11px] text-muted">{timeAgo(repo.commit.at)}</span>
        </div>
      </div>

      {/* what the remote has */}
      <div className="mt-3">
        {check.isError ? (
          <p className="text-xs text-warn">Could not reach the remote: {check.error.message}</p>
        ) : behind === null ? (
          <p className="text-xs text-muted">Checking the remote…</p>
        ) : behind > 0 ? (
          <div>
            <p className="text-xs text-white">
              {behind} new commit{behind > 1 ? 's' : ''} on origin/{check.data.branch}
            </p>
            <div className="mt-1.5 space-y-1">
              {check.data.commits.slice(0, 8).map((c) => (
                <div key={c.short} className="text-[12px] text-muted flex items-baseline gap-2">
                  <code className="font-mono text-gray-400">{c.short}</code>
                  <span className="min-w-0 break-words text-gray-300">{c.subject}</span>
                  <span className="text-[11px] shrink-0">{timeAgo(c.at)}</span>
                </div>
              ))}
              {check.data.commits.length > 8 && (
                <div className="text-[11px] text-muted">+{check.data.commits.length - 8} more</div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-ok flex items-center gap-1.5">
            <Icon.check /> Up to date with origin/{check.data?.branch}
            {check.data?.ahead > 0 && (
              <span className="text-warn">
                · {check.data.ahead} local commit{check.data.ahead > 1 ? 's' : ''} not pushed
              </span>
            )}
          </p>
        )}
      </div>

      {tracked.length > 0 && !running && (
        <p className="mt-3 text-xs text-warn">
          An update discards local edits to {tracked.length} tracked file{tracked.length > 1 ? 's' : ''}:{' '}
          <span className="font-mono text-gray-300">{tracked.slice(0, 4).join(', ')}</span>
          {tracked.length > 4 && ` +${tracked.length - 4} more`}
        </p>
      )}

      {/* actions */}
      <div className="mt-4 flex items-center gap-2 flex-wrap">
        {behind > 0 ? (
          <button onClick={() => update(false)} disabled={running || busy === 'update'} className="btn-brand">
            <Icon.download /> {running ? 'Updating…' : `Update to ${check.data.commits[0]?.short || 'latest'}`}
          </button>
        ) : (
          <button onClick={() => update(true)} disabled={running || busy === 'update'} className="btn-ghost">
            <Icon.restart /> {running ? 'Updating…' : 'Rebuild & restart'}
          </button>
        )}
        {reloadReady && (
          <button onClick={() => window.location.reload()} className="btn-brand">
            <Icon.restart /> Reload this page
          </button>
        )}
        {!running && (
          <span className="text-[11px] text-muted">The panel restarts — this page stalls for a few seconds.</span>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {/* progress / last run */}
      {job && <JobView job={job} log={data.log} disconnected={isError} />}

      {/* auto */}
      <div className="mt-5 pt-4 border-t border-line flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-white">Auto-redeploy on push</div>
          <p className="text-xs text-muted mt-0.5">
            A push to <span className="font-mono text-gray-300">{repo.branch}</span> of{' '}
            <span className="font-mono text-gray-300">{repo.repoFullName || 'the panel repo'}</span> updates the panel
            by itself. Needs the webhook below added to that repo too.
          </p>
        </div>
        <Toggle on={Boolean(settings.selfUpdateAuto)} onChange={toggleAuto} disabled={busy === 'auto' || running} />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- progress */

function JobView({ job, log, disconnected }) {
  const box = useRef(null);
  const running = job.status === 'running';

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log]);

  const tone =
    job.status === 'success' ? 'text-ok' : job.status === 'failed' ? 'text-danger' : 'text-warn';
  const headline = running
    ? `${STEPS[job.step] || job.step}…`
    : job.status === 'success'
      ? job.upToDate
        ? 'Already up to date'
        : job.rebuilt
          ? `Rebuilt ${job.to?.slice(0, 7)} and restarted`
          : `Updated ${job.from?.slice(0, 7)} → ${job.to?.slice(0, 7)}`
      : job.rolledBack
        ? 'Failed — rolled back to the previous version'
        : 'Failed';

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className={`text-xs font-medium flex items-center gap-2 ${tone}`}>
          {running && <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse-dot" />}
          {headline}
        </div>
        <div className="text-[11px] text-muted">
          {job.trigger === 'github' ? 'triggered by a push' : 'started manually'} · {timeAgo(job.startedAt)}
          {disconnected && running && <span className="text-warn"> · reconnecting…</span>}
        </div>
      </div>

      {job.error && <p className="mt-1 text-xs text-danger break-words">{job.error}</p>}
      {job.rolledBack && job.rollbackClean === false && (
        <p className="mt-1 text-xs text-danger">The rollback did not fully succeed — check the log and fix over SSH.</p>
      )}

      {log && (
        <pre
          ref={box}
          className="mt-2 max-h-64 overflow-auto rounded-lg border border-line bg-bg-input px-3 py-2 font-mono text-[11.5px] leading-relaxed text-gray-400 whitespace-pre-wrap break-words"
        >
          {log.trim()}
        </pre>
      )}
    </div>
  );
}
