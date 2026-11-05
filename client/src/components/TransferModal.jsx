import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Icon } from './Icons.jsx';
import Modal from './Modal.jsx';
import Toggle from './Toggle.jsx';
import ServerForm from './ServerForm.jsx';
import TransferJobView from './TransferJobView.jsx';

/**
 * Moving a whole project between two servers that both run this panel —
 * either direction, one dialog:
 *
 *   push  "Move this project to <server>"   (from a project)
 *   pull  "Import a project from <server>"  (from the Servers page)
 *
 * The defaults are the answer to "just move it": everything that makes the
 * project the project travels, the heavy rebuildable parts do not, the new
 * server deploys it on arrival and the old copy is removed once it is up.
 * Nothing here has to be touched before pressing the button.
 */

export const DEFAULT_OPTIONS = {
  dependencies: false,
  caches: false,
  databases: true,
  domains: true,
  history: true,
  deploy: true,
  stopSource: true,
  removeSource: true,
};

const ALWAYS = [
  'Every file in the project folder — the git repo, uploads and anything else the app wrote',
  'Each service\'s .env, byte for byte, plus its port, build and start commands',
  'Service names, pm2 names, icons and creation dates',
];

const OPTIONS = [
  { key: 'databases', label: 'Databases', hint: 'MySQL / PostgreSQL / MongoDB named in a .env and living on that server are dumped and restored under the same name, user and password — so the .env keeps working.' },
  { key: 'domains', label: 'Domains & HTTPS', hint: 'The nginx vhost of every attached domain is rebuilt on the new server; HTTPS follows once the domain\'s DNS points there.' },
  { key: 'deploy', label: 'Deploy on arrival', hint: 'Build and start every service on the new server right away, so the project comes up by itself.' },
  { key: 'history', label: 'Deployment history', hint: 'Past deployments and their logs come along.' },
  { key: 'dependencies', label: 'Dependencies', hint: 'node_modules, vendor, .venv … Off by default: the deploy reinstalls them, and sending them is usually far slower than rebuilding.' },
  { key: 'caches', label: 'Build caches', hint: '.next, .cache, .turbo, __pycache__ … Off by default: the deploy regenerates them.' },
  { key: 'stopSource', label: 'Pause while copying', hint: 'Stop the project on the old server for the duration of the copy, so files and database dumps are one consistent snapshot.' },
  { key: 'removeSource', label: 'Remove from the old server', hint: 'This is what makes it a move: once the project is confirmed up on the new server, its processes, domains and files are deleted from the old one. Turn it off to leave a copy behind.' },
];

const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
};

/* ------------------------------------------------------------ server pick */

function ServerRow({ server, selected, onPick }) {
  const bad = Boolean(server.lastError);
  return (
    <button
      type="button"
      onClick={onPick}
      className={`w-full text-left rounded-lg border px-3.5 py-3 transition ${
        selected ? 'border-brand bg-brand/5' : 'border-line bg-bg-input hover:border-brand/40'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 min-w-0">
          <Icon.server width={15} height={15} className={selected ? 'text-brand' : 'text-muted'} />
          <span className="text-sm text-white truncate">{server.name}</span>
        </span>
        {bad ? (
          <span className="chip bg-danger/10 border-danger/30 text-danger shrink-0">unreachable</span>
        ) : (
          <span className="chip bg-bg-hover border-line text-muted shrink-0 font-mono text-[10px]">
            {server.info?.hostname || 'linked'}
          </span>
        )}
      </div>
      <p className="text-xs text-muted font-mono mt-1 truncate">{server.url}</p>
      {bad && <p className="text-xs text-danger mt-1">{server.lastError}</p>}
    </button>
  );
}

/* ----------------------------------------------------------- project pick */

function RemoteProjectRow({ project, selected, onPick }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`w-full text-left rounded-lg border px-3.5 py-3 transition ${
        selected ? 'border-brand bg-brand/5' : 'border-line bg-bg-input hover:border-brand/40'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-white truncate">{project.name}</span>
        <span className="text-xs text-muted shrink-0">
          {project.services.length} service{project.services.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {project.services.map((s) => (
          <span key={s.id} className="chip bg-bg-hover border-line text-muted">
            {s.name}
            {s.port ? ` · :${s.port}` : s.kind === 'static' ? ' · static' : ''}
          </span>
        ))}
        {project.domains.map((h) => (
          <span key={h} className="chip bg-brand/10 border-brand/30 text-brand">{h}</span>
        ))}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------- the dialog */

export default function TransferModal({ open, onClose, direction = 'push', project = null, server = null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState('pick'); // pick | add | setup | run
  const [serverId, setServerId] = useState(null);
  const [remoteProject, setRemoteProject] = useState(null);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [rename, setRename] = useState('');
  const [renameTouched, setRenameTouched] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [inspect, setInspect] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState('');
  const [jobId, setJobId] = useState(null);
  const [startError, setStartError] = useState('');

  const { data: serversData } = useQuery({
    queryKey: ['transferServers'],
    queryFn: api.transferServers,
    enabled: open,
  });
  const servers = serversData?.servers || [];

  // Fresh dialog every time it opens. A push that already knows both ends
  // (started from the Servers page) skips straight to the summary.
  useEffect(() => {
    if (!open) return;
    setPhase(direction === 'push' && server?.id && project?.id ? 'setup' : 'pick');
    setServerId(server?.id || null);
    setRemoteProject(null);
    setOptions(DEFAULT_OPTIONS);
    setRename('');
    setRenameTouched(false);
    setShowOptions(false);
    setInspect(null);
    setInspectError('');
    setJobId(null);
    setStartError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server?.id, project?.id, direction]);

  // Pushing with exactly one linked server needs no choice at all.
  useEffect(() => {
    if (!open || phase !== 'pick' || direction !== 'push') return;
    if (!servers.length) setPhase('add');
    else if (servers.length === 1 && !serverId) {
      setServerId(servers[0].id);
      setPhase('setup');
    }
  }, [open, phase, direction, servers, serverId]);

  const { data: catalog, error: catalogError, isFetching: catalogLoading } = useQuery({
    queryKey: ['transferCatalog', serverId],
    queryFn: () => api.transferCatalog(serverId),
    enabled: open && direction === 'pull' && Boolean(serverId),
    staleTime: 15_000,
  });

  const projectId = direction === 'push' ? project?.id : remoteProject?.id;
  const projectName = direction === 'push' ? project?.name : remoteProject?.name;
  const serverName = servers.find((s) => s.id === serverId)?.name || server?.name || 'the other server';

  const payloadOptions = useMemo(
    () => ({ ...options, ...(rename.trim() ? { rename: rename.trim() } : {}) }),
    [options, rename]
  );

  // Dry run, re-done whenever a choice changes — the operator always sees
  // the real answer of the real destination before committing.
  useEffect(() => {
    if (!open || phase !== 'setup' || !projectId || !serverId) return;
    let alive = true;
    setInspecting(true);
    setInspectError('');
    const timer = setTimeout(async () => {
      try {
        const data = await api.transferInspect({ direction, serverId, projectId, options: payloadOptions });
        if (alive) setInspect(data);
      } catch (e) {
        if (alive) {
          setInspect(null);
          setInspectError(e.message);
        }
      } finally {
        if (alive) setInspecting(false);
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase, projectId, serverId, direction, payloadOptions]);

  // A name clash is the one problem the panel can solve for the operator.
  const blocking = inspect?.preflight?.blocking || [];
  useEffect(() => {
    if (renameTouched) return;
    if (blocking.some((b) => b.code === 'project-exists') && projectName) {
      setRename(`${projectName}-2`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocking.map((b) => b.code).join(','), projectName, renameTouched]);

  const start = async () => {
    setStartError('');
    try {
      const { jobId: id } = await api.transferStart({
        direction,
        serverId,
        projectId,
        projectName,
        options: payloadOptions,
      });
      setJobId(id);
      setPhase('run');
    } catch (e) {
      setStartError(e.message);
    }
  };

  const finished = () => {
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    queryClient.invalidateQueries({ queryKey: ['transferJobs'] });
    queryClient.invalidateQueries({ queryKey: ['transferCatalog', serverId] });
  };

  const title =
    phase === 'add'
      ? 'Link another server'
      : phase === 'run'
        ? 'Transfer'
        : direction === 'push'
          ? `Move “${project?.name || 'project'}” to another server`
          : `Import a project from ${serverName}`;

  const plan = inspect?.plan;
  const pre = inspect?.preflight;

  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      {/* ------------------------------------------------------------ add */}
      {phase === 'add' && (
        <>
          {!servers.length && (
            <p className="text-sm text-muted mb-4">
              No other server is linked yet. Enter the address of the other panel and the password you log into it
              with — once.
            </p>
          )}
          <ServerForm
            onSaved={(s) => {
              queryClient.invalidateQueries({ queryKey: ['transferServers'] });
              setServerId(s.id);
              setPhase(direction === 'push' ? 'setup' : 'pick');
            }}
            onCancel={servers.length ? () => setPhase('pick') : onClose}
          />
        </>
      )}

      {/* ----------------------------------------------------------- pick */}
      {phase === 'pick' && direction === 'push' && (
        <div className="space-y-2">
          <p className="text-sm text-gray-400 mb-3">Which server should it move to?</p>
          {servers.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              selected={serverId === s.id}
              onPick={() => {
                setServerId(s.id);
                setPhase('setup');
              }}
            />
          ))}
          <button onClick={() => setPhase('add')} className="btn-ghost w-full mt-2">
            <Icon.plus /> Link another server
          </button>
        </div>
      )}

      {phase === 'pick' && direction === 'pull' && (
        <div className="space-y-2">
          <p className="text-sm text-gray-400 mb-3">Which project should come over?</p>
          {catalogLoading && <p className="text-sm text-muted">Asking {serverName}…</p>}
          {catalogError && <p className="text-sm text-danger">{catalogError.message}</p>}
          {catalog?.projects?.length === 0 && (
            <p className="text-sm text-muted">{serverName} has no projects to hand over.</p>
          )}
          {catalog?.projects?.map((p) => (
            <RemoteProjectRow
              key={p.id}
              project={p}
              selected={remoteProject?.id === p.id}
              onPick={() => {
                setRemoteProject(p);
                setPhase('setup');
              }}
            />
          ))}
        </div>
      )}

      {/* ---------------------------------------------------------- setup */}
      {phase === 'setup' && (
        <div className="space-y-5">
          <div className="flex items-center gap-3 text-sm">
            <span className="chip bg-bg-hover border-line text-gray-200">
              {direction === 'push' ? 'this server' : serverName}
            </span>
            <Icon.move className="text-brand shrink-0" />
            <span className="chip bg-bg-hover border-line text-gray-200">
              {direction === 'push' ? serverName : 'this server'}
            </span>
            <span className="text-muted truncate">· {projectName}</span>
            {(servers.length > 1 || direction === 'pull') && (
              <button onClick={() => setPhase('pick')} className="text-xs text-muted hover:text-white ml-auto shrink-0">
                change
              </button>
            )}
          </div>

          {/* what travels */}
          <div>
            <p className="text-sm text-gray-300 mb-2">What moves</p>
            <ul className="space-y-1 mb-3">
              {ALWAYS.map((t) => (
                <li key={t} className="flex items-start gap-2 text-xs text-muted">
                  <span className="text-ok mt-px">✓</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
            <div className="space-y-1.5">
              {(showOptions ? OPTIONS : OPTIONS.filter((o) => ['databases', 'domains', 'removeSource'].includes(o.key))).map((o) => (
                <div
                  key={o.key}
                  className="flex items-start justify-between gap-3 bg-bg-input border border-line rounded-lg px-3.5 py-2.5 cursor-pointer"
                  onClick={() => setOptions((prev) => ({ ...prev, [o.key]: !prev[o.key] }))}
                >
                  <span className="min-w-0">
                    <span className="text-sm text-white">{o.label}</span>
                    <span className="block text-xs text-muted">{o.hint}</span>
                  </span>
                  <Toggle on={options[o.key]} onChange={() => {}} />
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowOptions(!showOptions)}
              className="text-xs text-muted hover:text-white mt-2"
            >
              {showOptions ? 'Fewer options' : 'All options (dependencies, caches, history, deploy, pause)'}
            </button>
          </div>

          {/* name on the other side */}
          {blocking.some((b) => ['project-exists', 'folder-exists'].includes(b.code)) && (
            <div>
              <label className="block text-sm text-gray-400 mb-2">Name on {direction === 'push' ? serverName : 'this server'}</label>
              <input
                value={rename}
                onChange={(e) => {
                  setRename(e.target.value);
                  setRenameTouched(true);
                }}
                className="input"
                placeholder={projectName || ''}
              />
            </div>
          )}

          {/* the dry run */}
          <div className="rounded-lg border border-line bg-bg-input p-3.5">
            {inspecting && !plan && <p className="text-sm text-muted">Looking at both servers…</p>}
            {inspectError && <p className="text-sm text-danger whitespace-pre-wrap">{inspectError}</p>}
            {plan && (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted mb-2">
                  <span className="text-gray-200">{fmtBytes(plan.totals.bytes)} to copy</span>
                  <span>{plan.totals.services} service(s)</span>
                  {Boolean(plan.totals.domains) && <span>{plan.totals.domains} domain(s)</span>}
                  {Boolean(plan.totals.databases) && <span>{plan.totals.databases} database(s)</span>}
                  {inspecting && <span className="text-brand">updating…</span>}
                </div>
                <div className="space-y-1 mb-2">
                  {plan.services.map((s) => (
                    <div key={s.slug} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-gray-300 truncate">
                        {s.name}
                        {s.port ? <span className="text-muted"> · :{s.port}</span> : null}
                        {s.databases?.filter((d) => d.local).map((d) => (
                          <span key={d.name} className="text-muted"> · {d.kind} {d.name}</span>
                        ))}
                      </span>
                      <span className="text-muted shrink-0">{fmtBytes(s.bytes)}</span>
                    </div>
                  ))}
                </div>
                {pre?.target && (
                  <p className="text-xs text-muted font-mono truncate">→ {pre.target.path}</p>
                )}
                {Boolean(pre?.ports?.length) && (
                  <p className="text-xs text-warn mt-2">
                    {pre.ports.map((p) => `${p.service}: port ${p.from} is taken there → ${p.to}`).join(' · ')}
                  </p>
                )}
                {Boolean(pre?.warnings?.length) && (
                  <ul className="mt-2 space-y-1">
                    {pre.warnings.map((w, i) => (
                      <li key={i} className="text-xs text-warn">! {w}</li>
                    ))}
                  </ul>
                )}
                {Boolean(pre?.notes?.length) && (
                  <ul className="mt-2 space-y-1">
                    {pre.notes.map((n, i) => (
                      <li key={i} className="text-xs text-muted">· {n}</li>
                    ))}
                  </ul>
                )}
                {Boolean(blocking.length) && (
                  <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 p-2.5">
                    {blocking.map((b, i) => (
                      <p key={i} className="text-xs text-danger">{b.message}</p>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {startError && <p className="text-sm text-danger">{startError}</p>}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button
              onClick={start}
              disabled={!plan || blocking.length > 0 || inspecting}
              className="btn-brand"
              title={blocking.length ? 'Fix the problem above first' : ''}
            >
              {direction === 'push' ? <Icon.upload /> : <Icon.download />}
              {options.removeSource
                ? direction === 'push' ? `Move to ${serverName}` : 'Move it here'
                : direction === 'push' ? `Copy to ${serverName}` : 'Copy it here'}
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ run */}
      {phase === 'run' && jobId && (
        <>
          <TransferJobView
            jobId={jobId}
            onFinished={finished}
            onOpenProject={(id) => {
              onClose();
              navigate(`/projects/${id}`);
            }}
          />
          <div className="flex justify-end gap-2 mt-5">
            <button onClick={onClose} className="btn-ghost">Close</button>
          </div>
          <p className="text-xs text-muted mt-2 text-right">
            Closing is safe — the transfer keeps running and you can follow it on the Servers page.
          </p>
        </>
      )}
    </Modal>
  );
}
