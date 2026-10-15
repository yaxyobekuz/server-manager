import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import Modal from '../components/Modal.jsx';
import { useMe, isOwner } from '../lib/useMe.js';
import { timeAgo } from '../lib/format.js';

/**
 * Owner-only admin management. An admin is just a unique password plus a
 * permission set and a project scope — they log in on the same login screen
 * and the panel shows only what they are allowed to touch.
 */

function AdminModal({ admin, permissions, projects, onClose, onSaved }) {
  const isNew = admin === 'new';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [allProjects, setAllProjects] = useState(false);
  const [projectIds, setProjectIds] = useState(new Set());
  const [perms, setPerms] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!admin) return;
    if (isNew) {
      setName('');
      setPassword('');
      setAllProjects(false);
      setProjectIds(new Set());
      setPerms({});
    } else {
      setName(admin.name);
      setPassword('');
      setAllProjects(admin.projects === 'all');
      setProjectIds(new Set(Array.isArray(admin.projects) ? admin.projects : []));
      setPerms({ ...(admin.permissions || {}) });
    }
    setError('');
    setBusy(false);
  }, [admin]);

  const groups = [...new Set(permissions.map((p) => p.group))];

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const payload = {
      name,
      permissions: perms,
      projects: allProjects ? 'all' : [...projectIds],
      ...(password ? { password } : {}),
    };
    try {
      if (isNew) await api.createAdmin(payload);
      else await api.updateAdmin(admin.id, payload);
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal open={!!admin} onClose={busy ? () => {} : onClose} title={isNew ? 'New admin' : `Edit ${admin?.name}`} wide>
      <form onSubmit={save}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Name</label>
            <input autoFocus={isNew} value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="developer" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">
              Password {!isNew && <span className="text-muted">(empty = keep current)</span>}
            </label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input font-mono"
              placeholder={isNew ? 'min 6 characters — this IS the login' : '••••••'}
            />
          </div>
        </div>
        <p className="text-[11px] text-muted mt-1.5">
          There are no usernames — the admin signs in on the same login screen using only this password, so it must be unique.
        </p>

        <div className="mt-5">
          <p className="text-sm text-gray-400 mb-2">Project access</p>
          <label className="flex items-center gap-2 text-sm text-gray-300 mb-2 cursor-pointer">
            <input type="checkbox" checked={allProjects} onChange={(e) => setAllProjects(e.target.checked)} className="accent-brand w-4 h-4" />
            All projects (including ones created later)
          </label>
          {!allProjects && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-40 overflow-y-auto bg-bg-input border border-line rounded-lg p-3">
              {projects.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer min-w-0">
                  <input
                    type="checkbox"
                    checked={projectIds.has(p.id)}
                    onChange={() =>
                      setProjectIds((prev) => {
                        const next = new Set(prev);
                        next.has(p.id) ? next.delete(p.id) : next.add(p.id);
                        return next;
                      })
                    }
                    className="accent-brand w-3.5 h-3.5 shrink-0"
                  />
                  <span className="truncate">{p.name}</span>
                </label>
              ))}
              {projects.length === 0 && <span className="text-xs text-muted">No projects yet.</span>}
            </div>
          )}
        </div>

        <div className="mt-5">
          <p className="text-sm text-gray-400 mb-2">Permissions</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {groups.map((g) => (
              <div key={g} className="bg-bg-input border border-line rounded-lg p-3">
                <p className={`text-[11px] uppercase tracking-wide mb-2 ${g === 'Danger zone' ? 'text-danger' : 'text-muted'}`}>{g}</p>
                <div className="space-y-1.5">
                  {permissions.filter((p) => p.group === g).map((p) => (
                    <label key={p.key} className="flex items-start gap-2 text-xs text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(perms[p.key])}
                        onChange={(e) => setPerms({ ...perms, [p.key]: e.target.checked })}
                        className="accent-brand w-3.5 h-3.5 mt-0.5 shrink-0"
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-danger mt-3">{error}</p>}
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} disabled={busy} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !name.trim() || (isNew && !password)} className="btn-brand">
            {busy ? 'Saving…' : isNew ? 'Create admin' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Admins() {
  const me = useMe();
  const queryClient = useQueryClient();
  const owner = isOwner(me);
  const [editing, setEditing] = useState(null); // 'new' | admin object

  const { data } = useQuery({ queryKey: ['admins'], queryFn: api.admins, enabled: owner });
  const { data: permData } = useQuery({ queryKey: ['adminPerms'], queryFn: api.adminPermissions, enabled: owner, staleTime: Infinity });
  const { data: projData } = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  const admins = data?.admins || [];
  const permissions = permData?.permissions || [];
  const projects = projData?.projects || [];
  const permLabel = Object.fromEntries(permissions.map((p) => [p.key, p.label]));

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admins'] });

  const toggleDisabled = async (a) => {
    await api.updateAdmin(a.id, { disabled: !a.disabled });
    refresh();
  };

  const remove = async (a) => {
    if (!confirm(`Delete admin "${a.name}"? Their password stops working immediately.`)) return;
    await api.deleteAdmin(a.id);
    refresh();
  };

  if (me && !owner) {
    return (
      <div className="p-8">
        <div className="card p-10 text-center max-w-md mx-auto mt-10 text-sm text-muted">Only the owner can manage admins.</div>
      </div>
    );
  }

  return (
    <div className="bg-grid-fade min-h-full">
      <header className="flex items-center justify-between px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <h1 className="text-[15px] font-semibold text-white">Admins</h1>
        <button onClick={() => setEditing('new')} className="btn-brand">
          <Icon.plus /> New admin
        </button>
      </header>

      <div className="p-8">
        <p className="text-xs text-muted mb-5 max-w-2xl">
          Admins sign in with their own password on the same login screen. They see only the projects you grant, and only the
          sections and actions their permissions allow — everything else is hidden and blocked on the server.
        </p>

        {admins.length === 0 ? (
          <div className="card p-14 text-center max-w-lg mx-auto mt-6">
            <div className="w-12 h-12 rounded-xl bg-bg-hover border border-line flex items-center justify-center mx-auto mb-4 text-brand">
              <Icon.shield />
            </div>
            <h2 className="text-white font-semibold mb-1">No admins yet</h2>
            <p className="text-sm text-muted mb-5">Create one to give somebody scoped access to this panel.</p>
            <button onClick={() => setEditing('new')} className="btn-brand mx-auto"><Icon.plus /> New admin</button>
          </div>
        ) : (
          <div className="space-y-3 max-w-3xl">
            {admins.map((a) => {
              const granted = permissions.filter((p) => a.permissions?.[p.key]);
              return (
                <div key={a.id} className={`card p-5 ${a.disabled ? 'opacity-60' : ''}`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Icon.shield className="text-brand shrink-0" />
                      <span className="font-semibold text-white truncate">{a.name}</span>
                      {a.disabled && <span className="chip bg-danger/10 border-danger/30 text-danger shrink-0">disabled</span>}
                      <span className="text-xs text-muted shrink-0">created {timeAgo(a.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-3 text-xs">
                      <button onClick={() => setEditing(a)} className="text-muted hover:text-white">Edit</button>
                      <button onClick={() => toggleDisabled(a)} className="text-muted hover:text-warn">
                        {a.disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button onClick={() => remove(a)} className="text-muted hover:text-danger"><Icon.trash /></button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="chip bg-bg-hover border-line text-gray-300">
                      {a.projects === 'all' ? 'all projects' : `${(a.projects || []).length} project${(a.projects || []).length !== 1 ? 's' : ''}`}
                    </span>
                    {granted.length === 0 && <span className="chip bg-bg-hover border-line text-muted">view only</span>}
                    {granted.map((p) => (
                      <span key={p.key} className="chip bg-brand/10 border-brand/30 text-brand" title={permLabel[p.key]}>
                        {p.key}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AdminModal
        admin={editing}
        permissions={permissions}
        projects={projects}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
    </div>
  );
}
