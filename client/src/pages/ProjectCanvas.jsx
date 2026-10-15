import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import { useMe, can } from '../lib/useMe.js';
import { timeAgo, DEPLOY_STATUS } from '../lib/format.js';
import Modal from '../components/Modal.jsx';
import NewServiceForm from '../components/NewServiceForm.jsx';
import CreatedAtEditor from '../components/CreatedAtEditor.jsx';

export default function ProjectCanvas() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [showCreated, setShowCreated] = useState(false);
  const [powering, setPowering] = useState(null); // 'stop' | 'start'
  const [powerMsg, setPowerMsg] = useState('');
  const me = useMe();
  const canEdit = can(me, 'editServices');

  const { data, error: loadError } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
  });
  const project = data?.project;
  const error = loadError?.message || '';

  // Live pm2 state of the project's services drives the Stop/Start buttons.
  const { data: procData } = useQuery({
    queryKey: ['projectProcs', id],
    queryFn: () => api.projectProcesses(id),
    refetchInterval: 10_000,
  });
  const procs = procData?.processes || [];
  const online = procs.filter((p) => p.status === 'online').length;
  const startable = procs.some((p) => p.status !== 'online' && p.status !== 'not running');

  const power = async (verb) => {
    if (
      verb === 'stop' &&
      !confirm(
        `Stop all running services of "${project.name}"?\n\n` +
          `Their pm2 processes stop and the sites they serve go down until you press Start or Deploy. ` +
          `Static services keep being served by nginx.`
      )
    )
      return;
    setPowering(verb);
    setPowerMsg('');
    try {
      const r = verb === 'stop' ? await api.stopProject(id) : await api.startProject(id);
      const failed = (r.results || []).filter((x) => !x.ok);
      if (failed.length) setPowerMsg(failed.map((f) => `${f.service}: ${f.output}`).join(' · '));
    } catch (e) {
      setPowerMsg(e.message);
    } finally {
      setPowering(null);
      queryClient.invalidateQueries({ queryKey: ['projectProcs', id] });
    }
  };

  const deleteProject = async () => {
    const warning =
      `Delete project "${project.name}" and all its services?\n\n` +
      `Each service will be torn down one by one:\n` +
      `• pm2 processes\n` +
      `• domains, nginx configs and SSL certificates\n` +
      `• service folders and the project folder itself`;
    if (!confirm(warning)) return;
    await api.deleteProject(id);
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    navigate('/');
  };

  if (!project) return <div className="p-8 text-muted">Loading…</div>;
  const services = project.services || [];

  return (
    <div className="min-h-full flex flex-col">
      <header className="flex items-center justify-between px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => navigate('/')} className="text-muted hover:text-white flex items-center gap-1">
            <Icon.back width={14} height={14} /> Projects
          </button>
          <span className="text-gray-300">/</span>
          <span className="text-white font-semibold">{project.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => canEdit && setShowCreated(true)}
            className="text-xs text-muted hover:text-white mr-2"
            title="Creation date — click to view or edit (changes are recorded)"
          >
            Created {timeAgo(project.createdAt)}
          </button>
          {procs.length > 0 && (
            <span
              className={`chip ${online > 0 ? 'bg-ok/10 border-ok/30 text-ok' : 'bg-bg-hover border-line text-muted'}`}
              title="pm2 processes of this project"
            >
              {online}/{procs.length} running
            </span>
          )}
          {can(me, 'deploy') && online > 0 && (
            <button
              onClick={() => power('stop')}
              disabled={!!powering}
              className="btn-ghost text-muted hover:text-danger"
              title="Stop every running pm2 process of this project"
            >
              <Icon.stop width={14} height={14} /> {powering === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {can(me, 'deploy') && startable && (
            <button
              onClick={() => power('start')}
              disabled={!!powering}
              className="btn-ghost text-muted hover:text-ok"
              title="Start the project's stopped pm2 processes"
            >
              <Icon.play width={14} height={14} /> {powering === 'start' ? 'Starting…' : 'Start'}
            </button>
          )}
          {can(me, 'deleteServices') && (
            <button onClick={deleteProject} className="btn-ghost text-muted hover:text-danger"><Icon.trash /></button>
          )}
          {canEdit && (
            <button onClick={() => setShowNew(true)} className="btn-brand"><Icon.plus /> New Service</button>
          )}
        </div>
      </header>

      {/* Canvas */}
      <div className="flex-1 relative bg-grid-fade p-10 overflow-auto">
        <div
          className="absolute inset-0 opacity-[0.4] pointer-events-none"
          style={{
            backgroundImage:
              'radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
        {error && <div className="relative chip bg-danger/10 border-danger/30 text-danger mb-4">{error}</div>}

        {services.length === 0 ? (
          <div className="relative card p-14 text-center max-w-md mx-auto mt-12">
            <div className="w-12 h-12 rounded-xl bg-bg-hover border border-line flex items-center justify-center mx-auto mb-4 text-brand">
              <Icon.box />
            </div>
            <h2 className="text-white font-semibold mb-1">Add your first service</h2>
            <p className="text-sm text-muted mb-5">Deploy from a GitHub repo or a local folder on this VPS.</p>
            {canEdit && <button onClick={() => setShowNew(true)} className="btn-brand mx-auto"><Icon.plus /> New Service</button>}
          </div>
        ) : (
          <div className="relative grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 max-w-5xl">
            {services.map((s) => (
              <ServiceCard key={s.id} service={s} onClick={() => navigate(`/projects/${id}/services/${s.id}`)} />
            ))}
          </div>
        )}
      </div>

      <Modal open={showCreated} onClose={() => setShowCreated(false)} title={`Created — ${project.name}`}>
        <CreatedAtEditor
          entity={project}
          onSave={async (iso) => {
            const { project: updated } = await api.setProjectCreatedAt(id, iso);
            queryClient.setQueryData(['project', id], (old) => ({
              project: { ...updated, services: old?.project?.services || [] },
            }));
            queryClient.invalidateQueries({ queryKey: ['projects'] });
          }}
        />
      </Modal>

      <Modal open={showNew} onClose={() => setShowNew(false)} title="Deploy a new service" wide>
        <NewServiceForm
          projectId={id}
          projectName={project.name}
          onCreated={(svc) => {
            setShowNew(false);
            queryClient.invalidateQueries({ queryKey: ['project', id] });
            queryClient.invalidateQueries({ queryKey: ['projects'] });
            navigate(`/projects/${id}/services/${svc.id}`);
          }}
          onCancel={() => setShowNew(false)}
        />
      </Modal>
    </div>
  );
}

function ServiceCard({ service, onClick }) {
  const st = DEPLOY_STATUS[service.latestDeployment?.status] || DEPLOY_STATUS.none;
  const SourceIcon = service.sourceType === 'github' ? Icon.github : Icon.box;
  return (
    <button
      onClick={onClick}
      className="card p-5 text-left hover:border-brand/40 hover:shadow-glow transition group"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-bg-hover border border-line flex items-center justify-center text-gray-300 shrink-0">
            <SourceIcon width={16} height={16} />
          </div>
          <span className="font-semibold text-white truncate group-hover:text-brand transition">{service.name}</span>
        </div>
        <span className={`chip ${st.bg} ${st.color} shrink-0`}>
          <span className={`w-1.5 h-1.5 rounded-full ${st.dot} ${['building', 'deploying'].includes(service.latestDeployment?.status) ? 'animate-pulse-dot' : ''}`} />
          {st.label}
        </span>
      </div>
      <p className="text-xs text-muted truncate mb-3">
        {service.sourceType === 'github' ? (service.repoFullName || service.repoUrl || 'github') : (service.localPath || 'local')}
        {service.branch ? ` · ${service.branch}` : ''}
      </p>
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{service.deploymentCount || 0} deployment{service.deploymentCount !== 1 ? 's' : ''}</span>
        {service.latestDeployment && <span>{timeAgo(service.latestDeployment.createdAt)}</span>}
      </div>
    </button>
  );
}
