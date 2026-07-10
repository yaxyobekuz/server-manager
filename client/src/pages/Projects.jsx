import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { Icon, StatusDot } from '../components/Icons.jsx';
import { timeAgo, DEPLOY_STATUS } from '../lib/format.js';
import Modal from '../components/Modal.jsx';

function Toggle({ on, onChange }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${on ? 'bg-brand' : 'bg-bg-hover border border-line'}`}
      aria-pressed={on}
    >
      <span className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white transition-all ${on ? 'left-[19px]' : 'left-[3px]'}`} />
    </button>
  );
}

/**
 * Copy a project: recreates every service (config + variables) under a new
 * project. Toggled-on services deploy right away; the rest just get created.
 * Domains are never copied — a copy always gets fresh domains.
 */
function CopyProjectModal({ project, onClose }) {
  const navigate = useNavigate();
  const services = project?.services || [];
  const [name, setName] = useState('');
  const [deployIds, setDeployIds] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (project) {
      setName(`${project.name}-copy`);
      setDeployIds(new Set());
      setError('');
    }
  }, [project]);

  const toggle = (id) =>
    setDeployIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const copy = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const { project: created } = await api.copyProject(project.id, {
        name,
        deployServiceIds: [...deployIds],
      });
      navigate(`/projects/${created.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal open={!!project} onClose={busy ? () => {} : onClose} title={project ? `Copy “${project.name}”` : ''}>
      <form onSubmit={copy}>
        <label className="block text-sm text-gray-400 mb-2">New project name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="my-project-copy" />

        <div className="mt-5">
          <p className="text-sm text-gray-400 mb-1">Services</p>
          <p className="text-xs text-muted mb-3">
            Toggled-on services deploy immediately after the copy. The others are only copied — deploy them whenever you want.
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {services.length === 0 && <p className="text-sm text-muted">This project has no services — an empty project will be created.</p>}
            {services.map((s) => (
              <div key={s.id} className="flex items-center justify-between bg-bg-input border border-line rounded-lg px-3.5 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon.box width={15} height={15} className="text-brand shrink-0" />
                  <span className="text-sm text-white truncate">{s.name}</span>
                  <span className="chip bg-bg-hover border-line text-muted shrink-0">{s.serviceKind === 'static' ? 'static' : s.sourceType === 'github' ? 'github' : 'local'}</span>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted shrink-0 ml-3 cursor-pointer" onClick={() => toggle(s.id)}>
                  {deployIds.has(s.id) ? 'deploy after copy' : 'copy only'}
                  <Toggle on={deployIds.has(s.id)} onChange={() => {}} />
                </label>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted mt-3">
            Domains are never copied — attach new domains to the copied services in their Domains tab.
          </p>
        </div>

        {error && <p className="text-sm text-danger mt-3">{error}</p>}
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} disabled={busy} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !name.trim()} className="btn-brand">
            <Icon.copy /> {busy ? 'Copying…' : 'Copy project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [menuFor, setMenuFor] = useState(null); // project id with the dropdown open
  const [copying, setCopying] = useState(null); // project being copied
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  // Match against project name, description and its services' names.
  const q = query.trim().toLowerCase();
  const visible = !q
    ? projects
    : projects.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q) ||
          (p.services || []).some((s) => s.name.toLowerCase().includes(q))
      );

  const load = () => api.projects().then((d) => setProjects(d.projects)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  // Any click outside the dropdown closes it (the trigger stops propagation).
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuFor]);

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
      <header className="flex items-center justify-between gap-4 px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <h1 className="text-[15px] font-semibold text-white shrink-0">Projects</h1>
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative w-64 max-w-full">
            <Icon.search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              className="input h-9 pl-9 pr-8 text-sm"
              placeholder="Find a project…"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-white text-sm leading-none px-1"
                title="Clear"
              >
                ×
              </button>
            )}
          </div>
          <button onClick={() => setShowNew(true)} className="btn-brand shrink-0">
            <Icon.plus /> New Project
          </button>
        </div>
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
        ) : visible.length === 0 ? (
          <div className="card p-10 text-center max-w-lg mx-auto mt-10">
            <div className="w-10 h-10 rounded-xl bg-bg-hover border border-line flex items-center justify-center mx-auto mb-3 text-muted">
              <Icon.search />
            </div>
            <p className="text-sm text-muted">
              Nothing matches “{query.trim()}” — searched project names, descriptions and service names.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visible.map((p) => {
              const services = p.services || [];
              return (
                <div
                  key={p.id}
                  onClick={() => navigate(`/projects/${p.id}`)}
                  className="relative card p-5 text-left hover:border-brand/40 hover:shadow-glow transition group cursor-pointer"
                >
                  <div className="flex items-center justify-between mb-4">
                    <span className="font-semibold text-white group-hover:text-brand transition">{p.name}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === p.id ? null : p.id); }}
                      className="p-1.5 -m-1.5 rounded-md text-muted hover:text-white hover:bg-bg-hover transition"
                      title="Project actions"
                    >
                      <Icon.dots />
                    </button>
                  </div>

                  {menuFor === p.id && (
                    <div
                      className="absolute right-4 top-12 z-20 card p-1.5 w-44 shadow-glow"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => { setMenuFor(null); setCopying(p); }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-bg-hover rounded-md transition"
                      >
                        <Icon.copy /> Copy project
                      </button>
                    </div>
                  )}

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
                </div>
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

      <CopyProjectModal project={copying} onClose={() => setCopying(null)} />
    </div>
  );
}
