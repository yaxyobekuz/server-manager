import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import { timeAgo, DEPLOY_STATUS } from '../lib/format.js';
import Modal from '../components/Modal.jsx';
import NewServiceForm from '../components/NewServiceForm.jsx';
import CreatedAtEditor from '../components/CreatedAtEditor.jsx';

export default function ProjectCanvas() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showCreated, setShowCreated] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.project(id).then((d) => setProject(d.project)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  const deleteProject = async () => {
    const warning =
      `Delete project "${project.name}" and all its services?\n\n` +
      `Each service will be torn down one by one:\n` +
      `• pm2 processes\n` +
      `• domains, nginx configs and SSL certificates\n` +
      `• service folders and the project folder itself`;
    if (!confirm(warning)) return;
    await api.deleteProject(id);
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
            onClick={() => setShowCreated(true)}
            className="text-xs text-muted hover:text-white mr-2"
            title="Creation date — click to view or edit (changes are recorded)"
          >
            Created {timeAgo(project.createdAt)}
          </button>
          <button onClick={deleteProject} className="btn-ghost text-muted hover:text-danger"><Icon.trash /></button>
          <button onClick={() => setShowNew(true)} className="btn-brand"><Icon.plus /> New Service</button>
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
            <button onClick={() => setShowNew(true)} className="btn-brand mx-auto"><Icon.plus /> New Service</button>
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
            setProject((prev) => ({ ...updated, services: prev.services }));
          }}
        />
      </Modal>

      <Modal open={showNew} onClose={() => setShowNew(false)} title="Deploy a new service" wide>
        <NewServiceForm
          projectId={id}
          projectName={project.name}
          onCreated={(svc) => { setShowNew(false); navigate(`/projects/${id}/services/${svc.id}`); }}
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
