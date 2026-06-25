import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { Icon, StatusDot } from '../components/Icons.jsx';
import { timeAgo, DEPLOY_STATUS } from '../lib/format.js';
import Modal from '../components/Modal.jsx';

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const load = () => api.projects().then((d) => setProjects(d.projects)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    try {
      const { project } = await api.createProject({ name });
      setShowNew(false);
      setName('');
      navigate(`/projects/${project.id}`);
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="bg-grid-fade min-h-full">
      <header className="flex items-center justify-between px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <h1 className="text-[15px] font-semibold text-white">Projects</h1>
        <button onClick={() => setShowNew(true)} className="btn-brand">
          <Icon.plus /> New Project
        </button>
      </header>

      <div className="p-8">
        {error && <div className="mb-4 chip bg-danger/10 border-danger/30 text-danger">{error}</div>}

        {projects.length === 0 ? (
          <div className="card p-16 text-center max-w-lg mx-auto mt-10">
            <div className="w-12 h-12 rounded-xl bg-bg-hover border border-line flex items-center justify-center mx-auto mb-4 text-brand">
              <Icon.grid />
            </div>
            <h2 className="text-white font-semibold mb-1">No projects yet</h2>
            <p className="text-sm text-muted mb-5">Create a project to group your services and start deploying.</p>
            <button onClick={() => setShowNew(true)} className="btn-brand mx-auto"><Icon.plus /> New Project</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((p) => {
              const services = p.services || [];
              return (
                <button
                  key={p.id}
                  onClick={() => navigate(`/projects/${p.id}`)}
                  className="card p-5 text-left hover:border-brand/40 hover:shadow-glow transition group"
                >
                  <div className="flex items-center justify-between mb-4">
                    <span className="font-semibold text-white group-hover:text-brand transition">{p.name}</span>
                    <Icon.chevron className="text-muted group-hover:text-brand transition" />
                  </div>
                  <div className="flex flex-wrap gap-1.5 mb-4 min-h-[24px]">
                    {services.slice(0, 4).map((s) => {
                      const st = DEPLOY_STATUS[s.latestDeployment?.status] || DEPLOY_STATUS.none;
                      return (
                        <span key={s.id} className={`chip ${st.bg} ${st.color}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} /> {s.name}
                        </span>
                      );
                    })}
                    {services.length === 0 && <span className="text-xs text-muted">No services</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {services.length} service{services.length !== 1 ? 's' : ''} · {timeAgo(p.createdAt)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={showNew} onClose={() => setShowNew(false)} title="Create a new project">
        <form onSubmit={create}>
          <label className="block text-sm text-gray-400 mb-2">Project name</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="my-backend" />
          <div className="flex justify-end gap-2 mt-6">
            <button type="button" onClick={() => setShowNew(false)} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={!name} className="btn-brand">Create</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
