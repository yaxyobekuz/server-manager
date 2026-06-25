import { useState } from 'react';
import { api } from '../api/client.js';
import { Icon } from './Icons.jsx';

export default function NewServiceForm({ projectId, onCreated, onCancel }) {
  const [step, setStep] = useState('source'); // 'source' | 'configure'
  const [sourceType, setSourceType] = useState('github');
  const [form, setForm] = useState({
    name: '',
    repoUrl: '',
    branch: 'main',
    localPath: '',
    rootDirectory: '',
    buildCommand: '',
    startCommand: '',
    port: '',
    autoDeploy: true,
  });
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const pickSource = (type) => {
    setSourceType(type);
    setStep('configure');
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    // Derive a sensible name if empty.
    let name = form.name;
    if (!name) {
      name = sourceType === 'github'
        ? (form.repoUrl.match(/\/([^/.]+)(?:\.git)?$/)?.[1] || 'service')
        : (form.localPath.split('/').filter(Boolean).pop() || 'service');
    }
    try {
      const { service } = await api.createService({
        projectId, sourceType, ...form, name, pm2Name: name,
      });
      onCreated(service);
    } catch (err) { setError(err.message); }
  };

  if (step === 'source') {
    return (
      <div>
        <div className="grid grid-cols-2 gap-3">
          <SourceOption
            icon={<Icon.github width={22} height={22} />}
            title="GitHub Repo"
            desc="Clone & deploy from a Git repository"
            onClick={() => pickSource('github')}
          />
          <SourceOption
            icon={<Icon.box width={22} height={22} />}
            title="Local Folder"
            desc="Deploy an existing folder on this VPS"
            onClick={() => pickSource('local')}
          />
        </div>
        <div className="flex justify-end mt-6">
          <button onClick={onCancel} className="btn-ghost">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <button type="button" onClick={() => setStep('source')} className="text-xs text-muted hover:text-white flex items-center gap-1">
        <Icon.back width={13} height={13} /> Change source
      </button>

      {sourceType === 'github' ? (
        <>
          <Field label="Repository URL" value={form.repoUrl} onChange={(v) => set('repoUrl', v)} placeholder="https://github.com/owner/repo" autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch" value={form.branch} onChange={(v) => set('branch', v)} placeholder="main" />
            <Field label="Root directory" value={form.rootDirectory} onChange={(v) => set('rootDirectory', v)} placeholder="(optional) server" />
          </div>
          <Field label="Deploy to (VPS path)" value={form.localPath} onChange={(v) => set('localPath', v)} placeholder="/var/www/myapp" />
        </>
      ) : (
        <Field label="Folder path on VPS" value={form.localPath} onChange={(v) => set('localPath', v)} placeholder="/var/www/myapp" autoFocus />
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Service name" value={form.name} onChange={(v) => set('name', v)} placeholder="auto from source" />
        <Field label="Port" value={form.port} onChange={(v) => set('port', v)} placeholder="3000" />
      </div>
      <Field label="Build command" value={form.buildCommand} onChange={(v) => set('buildCommand', v)} placeholder="npm ci && npm run build" mono />
      <Field label="Start command" value={form.startCommand} onChange={(v) => set('startCommand', v)} placeholder="npm start" mono />

      {sourceType === 'github' && (
        <label className="flex items-center gap-2.5 text-sm text-gray-300">
          <input type="checkbox" checked={form.autoDeploy} onChange={(e) => set('autoDeploy', e.target.checked)} className="accent-brand w-4 h-4" />
          Auto-deploy on every push (via GitHub webhook)
        </label>
      )}

      {error && <p className="text-danger text-sm">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="btn-ghost">Cancel</button>
        <button type="submit" className="btn-brand"><Icon.rocket width={15} height={15} /> Create Service</button>
      </div>
    </form>
  );
}

function SourceOption({ icon, title, desc, onClick }) {
  return (
    <button type="button" onClick={onClick} className="card p-5 text-left hover:border-brand/50 hover:shadow-glow transition">
      <div className="w-11 h-11 rounded-lg bg-bg-hover border border-line flex items-center justify-center text-brand mb-3">{icon}</div>
      <div className="font-semibold text-white mb-1">{title}</div>
      <div className="text-xs text-muted">{desc}</div>
    </button>
  );
}

function Field({ label, value, onChange, placeholder, autoFocus, mono }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5">{label}</label>
      <input
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`input ${mono ? 'font-mono text-xs' : ''}`}
      />
    </div>
  );
}
