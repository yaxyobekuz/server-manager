import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import Modal from '../components/Modal.jsx';
import ServerForm from '../components/ServerForm.jsx';
import TransferModal from '../components/TransferModal.jsx';
import TransferJobView from '../components/TransferJobView.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * The other servers running this panel, and every project transfer that has
 * happened. A server is linked once (its address + its admin password) and
 * from then on projects move either way with a single press.
 */

const STATUS = {
  running: { label: 'Running', cls: 'bg-brand/10 border-brand/30 text-brand' },
  success: { label: 'Done', cls: 'bg-ok/10 border-ok/30 text-ok' },
  warning: { label: 'Check notes', cls: 'bg-warn/10 border-warn/30 text-warn' },
  failed: { label: 'Stopped', cls: 'bg-danger/10 border-danger/30 text-danger' },
};

const DIRECTION = {
  push: { label: 'sent to', icon: Icon.upload },
  pull: { label: 'imported from', icon: Icon.download },
  incoming: { label: 'pushed here by', icon: Icon.download },
};

function duration(job) {
  if (!job.finishedAt) return '';
  const ms = new Date(job.finishedAt) - new Date(job.startedAt);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Choose which local project to send — the only step a push needs first. */
function ProjectPicker({ open, onClose, onPick }) {
  const { data } = useQuery({ queryKey: ['projects'], queryFn: api.projects, enabled: open });
  const projects = data?.projects || [];
  return (
    <Modal open={open} onClose={onClose} title="Which project should move?">
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {projects.length === 0 && <p className="text-sm text-muted">This server has no projects yet.</p>}
        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => onPick(p)}
            className="w-full text-left rounded-lg border border-line bg-bg-input hover:border-brand/40 px-3.5 py-3 transition"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-white truncate">{p.name}</span>
              <span className="text-xs text-muted shrink-0">
                {(p.services || []).length} service{(p.services || []).length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {(p.services || []).map((s) => (
                <span key={s.id} className="chip bg-bg-hover border-line text-muted">{s.name}</span>
              ))}
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export default function Servers() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [checking, setChecking] = useState(null);
  const [error, setError] = useState('');
  const [importFrom, setImportFrom] = useState(null); // server to pull from
  const [pickFor, setPickFor] = useState(null); // server to push to, choosing the project
  const [pushing, setPushing] = useState(null); // { server, project }
  const [viewJob, setViewJob] = useState(null);

  const { data, error: loadError } = useQuery({ queryKey: ['transferServers'], queryFn: api.transferServers });
  const servers = data?.servers || [];
  const here = data?.here;

  const { data: jobsData } = useQuery({
    queryKey: ['transferJobs'],
    queryFn: api.transferJobs,
    refetchInterval: 5000,
  });
  const jobs = jobsData?.jobs || [];

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['transferServers'] });
    queryClient.invalidateQueries({ queryKey: ['transferJobs'] });
  };

  const check = async (s) => {
    setChecking(s.id);
    setError('');
    try {
      await api.checkTransferServer(s.id);
    } catch (e) {
      setError(`${s.name}: ${e.message}`);
    } finally {
      setChecking(null);
      refresh();
    }
  };

  const unlink = async (s) => {
    if (!confirm(`Unlink ${s.name}?\n\nOnly this link and its saved password are removed — nothing on that server is touched.`)) return;
    await api.deleteTransferServer(s.id);
    refresh();
  };

  const forget = async (job) => {
    await api.deleteTransferJob(job.id);
    queryClient.invalidateQueries({ queryKey: ['transferJobs'] });
  };

  return (
    <div className="bg-grid-fade min-h-full">
      <header className="flex items-center justify-between gap-4 px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <h1 className="text-[15px] font-semibold text-white">Servers</h1>
        <button onClick={() => setAdding(true)} className="btn-brand">
          <Icon.plus /> Link a server
        </button>
      </header>

      <div className="p-8 space-y-8">
        {(error || loadError) && (
          <div className="chip bg-danger/10 border-danger/30 text-danger">{error || loadError.message}</div>
        )}

        {/* this machine */}
        {here && (
          <div className="card p-5">
            <div className="flex items-center gap-2.5 mb-3">
              <Icon.server width={16} height={16} className="text-brand" />
              <span className="font-semibold text-white">{here.hostname}</span>
              <span className="chip bg-ok/10 border-ok/30 text-ok">this server</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
              <div>
                <p className="text-muted mb-0.5">Projects live in</p>
                <p className="text-gray-200 font-mono">{here.projectsRoot}</p>
              </div>
              <div>
                <p className="text-muted mb-0.5">Address</p>
                <p className="text-gray-200 font-mono">{here.address || '—'}</p>
              </div>
              <div>
                <p className="text-muted mb-0.5">Node</p>
                <p className="text-gray-200 font-mono">{here.node}</p>
              </div>
              <div>
                <p className="text-muted mb-0.5">Database tools</p>
                <p className="text-gray-200">
                  {['mysql', 'postgres', 'mongo'].filter((k) => here.tools?.[k]).join(', ') || 'none installed'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* linked servers */}
        <div>
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Linked servers</h2>
          {servers.length === 0 ? (
            <div className="card p-10 text-center max-w-lg">
              <div className="w-10 h-10 rounded-xl bg-bg-hover border border-line flex items-center justify-center mx-auto mb-3 text-brand">
                <Icon.server />
              </div>
              <p className="text-sm text-white mb-1">No other server linked yet</p>
              <p className="text-xs text-muted mb-4">
                Link the other machine once — its panel address and the password you log into it with — and projects
                move between them in one press, either direction.
              </p>
              <button onClick={() => setAdding(true)} className="btn-brand mx-auto">
                <Icon.plus /> Link a server
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {servers.map((s) => (
                <div key={s.id} className="card p-5">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Icon.server width={16} height={16} className="text-muted" />
                        <span className="font-semibold text-white truncate">{s.name}</span>
                        {s.lastError ? (
                          <span className="chip bg-danger/10 border-danger/30 text-danger">unreachable</span>
                        ) : (
                          <span className="chip bg-ok/10 border-ok/30 text-ok">linked</span>
                        )}
                      </div>
                      <p className="text-xs text-muted font-mono mt-1 truncate">{s.url}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => check(s)} disabled={checking === s.id} className="btn-ghost px-2 py-1.5" title="Check the connection">
                        <Icon.restart width={14} height={14} />
                      </button>
                      <button onClick={() => setEditing(s)} className="btn-ghost px-2 py-1.5" title="Address, password, name">
                        <Icon.settings width={14} height={14} />
                      </button>
                      <button onClick={() => unlink(s)} className="btn-ghost px-2 py-1.5 hover:text-danger" title="Unlink">
                        <Icon.trash width={14} height={14} />
                      </button>
                    </div>
                  </div>

                  {s.lastError ? (
                    <p className="text-xs text-danger mb-3">{s.lastError}</p>
                  ) : (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted mb-3">
                      <span>{s.info?.hostname || '—'}</span>
                      <span className="font-mono">{s.info?.projectsRoot || ''}</span>
                      {s.lastSeenAt && <span>seen {timeAgo(s.lastSeenAt)}</span>}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button onClick={() => setImportFrom(s)} className="btn-ghost flex-1">
                      <Icon.download /> Import a project
                    </button>
                    <button onClick={() => setPickFor(s)} className="btn-ghost flex-1">
                      <Icon.upload /> Send a project
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* history */}
        <div>
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Transfers</h2>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted">Nothing has moved yet.</p>
          ) : (
            <div className="card divide-y divide-line">
              {jobs.map((j) => {
                const st = STATUS[j.status] || STATUS.running;
                const dir = DIRECTION[j.direction] || DIRECTION.push;
                const DirIcon = dir.icon;
                return (
                  <div key={j.id} className="flex items-center gap-3 px-4 py-3">
                    <DirIcon className="text-muted shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-white truncate">
                        {j.projectName || 'project'}
                        <span className="text-muted"> {dir.label} {j.serverName}</span>
                      </p>
                      <p className="text-xs text-muted truncate">
                        {timeAgo(j.startedAt)}
                        {duration(j) ? ` · ${duration(j)}` : ''}
                        {j.released ? ' · removed at the source' : j.pendingRelease ? ' · still on the old server' : ''}
                        {j.phase && j.status === 'running' ? ` · ${j.phase}` : ''}
                      </p>
                    </div>
                    <span className={`chip shrink-0 ${st.cls}`}>{st.label}</span>
                    <button onClick={() => setViewJob(j)} className="btn-ghost px-2.5 py-1.5 text-xs shrink-0">
                      <Icon.list width={13} height={13} /> Log
                    </button>
                    {j.status !== 'running' && (
                      <button onClick={() => forget(j)} className="text-muted hover:text-danger px-1 shrink-0" title="Remove from this list">
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="Link another server">
        <p className="text-sm text-muted mb-4">
          The other machine must be running this same panel. Its admin password is asked once and then kept
          encrypted here.
        </p>
        <ServerForm
          onSaved={() => {
            setAdding(false);
            refresh();
          }}
          onCancel={() => setAdding(false)}
        />
      </Modal>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing ? `Edit ${editing.name}` : ''}>
        {editing && (
          <ServerForm
            existing={editing}
            onSaved={() => {
              setEditing(null);
              refresh();
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>

      <ProjectPicker
        open={Boolean(pickFor)}
        onClose={() => setPickFor(null)}
        onPick={(p) => {
          setPushing({ server: pickFor, project: p });
          setPickFor(null);
        }}
      />

      <TransferModal
        open={Boolean(importFrom)}
        onClose={() => {
          setImportFrom(null);
          refresh();
        }}
        direction="pull"
        server={importFrom}
      />

      <TransferModal
        open={Boolean(pushing)}
        onClose={() => {
          setPushing(null);
          refresh();
        }}
        direction="push"
        server={pushing?.server}
        project={pushing?.project}
      />

      <Modal open={Boolean(viewJob)} onClose={() => setViewJob(null)} title="Transfer log" wide>
        {viewJob && <TransferJobView jobId={viewJob.id} onFinished={refresh} />}
        <div className="flex justify-end mt-5">
          <button onClick={() => setViewJob(null)} className="btn-ghost">Close</button>
        </div>
      </Modal>
    </div>
  );
}
