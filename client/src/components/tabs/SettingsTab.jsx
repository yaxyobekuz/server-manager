import { useState } from 'react';
import { api } from '../../api/client.js';
import { Icon } from '../Icons.jsx';
import CreatedAtEditor from '../CreatedAtEditor.jsx';

// Only the fields this tab actually edits. Snapshotting the WHOLE service
// here and PATCHing it back used to silently revert variables/domains saved
// in other tabs after this one was mounted.
const EDITABLE = [
  'name', 'repoUrl', 'branch', 'rootDirectory', 'localPath',
  'serviceKind', 'buildCommand', 'startCommand', 'staticOutputDir',
  'port', 'autoDeploy',
];
const pickEditable = (service) => Object.fromEntries(EDITABLE.map((k) => [k, service[k] ?? '']));

export default function SettingsTab({ service, onChange, onDeleted }) {
  const [form, setForm] = useState(pickEditable(service));
  const [saved, setSaved] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (patch) => {
    const { service: updated } = await api.updateService(service.id, patch || form);
    onChange(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const remove = async () => {
    const warning =
      `Delete service "${service.name}"?\n\n` +
      `This permanently removes everything it owns:\n` +
      `• pm2 process (${service.pm2Name || service.name})\n` +
      `• domains, nginx configs and SSL certificates\n` +
      `• its folder: ${service.localPath || '—'}`;
    if (!confirm(warning)) return;
    await api.deleteService(service.id);
    onDeleted();
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <Section title="Source" desc="Where the code comes from.">
        <Row label="Service name"><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} /></Row>
        {service.sourceType === 'github' && (
          <>
            <Row label="Repository"><input className="input" value={form.repoUrl} onChange={(e) => set('repoUrl', e.target.value)} placeholder="https://github.com/owner/repo" /></Row>
            <Row label="Branch"><input className="input" value={form.branch} onChange={(e) => set('branch', e.target.value)} /></Row>
            <Row label="Root directory"><input className="input" value={form.rootDirectory} onChange={(e) => set('rootDirectory', e.target.value)} placeholder="(optional)" /></Row>
          </>
        )}
        <Row label="VPS path"><input className="input font-mono text-xs" value={form.localPath} onChange={(e) => set('localPath', e.target.value)} placeholder="/var/www/myapp" /></Row>
      </Section>

      <Section title="Build & Deploy" desc="Leave fields empty to auto-detect from the project on deploy.">
        <Row label="Service type">
          <select className="input" value={form.serviceKind || 'auto'} onChange={(e) => set('serviceKind', e.target.value)}>
            <option value="auto">Auto-detect</option>
            <option value="backend">Backend (pm2 process)</option>
            <option value="static">Static site (React/Vite build)</option>
          </select>
        </Row>
        <Row label="Build command"><input className="input font-mono text-xs" value={form.buildCommand} onChange={(e) => set('buildCommand', e.target.value)} placeholder="auto (e.g. npm install && npm run build)" /></Row>
        {form.serviceKind !== 'static' && (
          <>
            <Row label="Start command"><input className="input font-mono text-xs" value={form.startCommand} onChange={(e) => set('startCommand', e.target.value)} placeholder="auto (e.g. npm start)" /></Row>
            <Row label="Port"><input className="input" value={form.port} onChange={(e) => set('port', e.target.value)} placeholder="3000" /></Row>
          </>
        )}
        {form.serviceKind === 'static' && (
          <Row label="Output directory"><input className="input font-mono text-xs" value={form.staticOutputDir || ''} onChange={(e) => set('staticOutputDir', e.target.value)} placeholder="auto (dist / build)" /></Row>
        )}
        {service.sourceType === 'github' && (
          <Row label="Auto-deploy">
            <button
              onClick={() => { const v = !form.autoDeploy; set('autoDeploy', v); save({ autoDeploy: v }); }}
              className={`relative w-11 h-6 rounded-full transition ${form.autoDeploy ? 'bg-ok' : 'bg-line'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition ${form.autoDeploy ? 'translate-x-5' : ''}`} />
            </button>
          </Row>
        )}
      </Section>

      <Section title="Created" desc="When this service was first deployed. Editable — every change is kept in the history below.">
        <CreatedAtEditor
          entity={service}
          onSave={async (iso) => {
            const { service: updated } = await api.setServiceCreatedAt(service.id, iso);
            onChange(updated);
          }}
        />
      </Section>

      <div className="flex items-center justify-between">
        <button onClick={remove} className="btn-danger"><Icon.trash /> Delete service</button>
        <button onClick={() => save()} className="btn-brand">{saved ? <><Icon.check /> Saved</> : 'Save changes'}</button>
      </div>
    </div>
  );
}

function Section({ title, desc, children }) {
  return (
    <div className="card p-6">
      <h3 className="text-white font-semibold">{title}</h3>
      {desc && <p className="text-xs text-muted mt-0.5 mb-4">{desc}</p>}
      <div className={`space-y-3 ${desc ? '' : 'mt-4'}`}>{children}</div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-center gap-4">
      <label className="text-sm text-gray-400">{label}</label>
      {children}
    </div>
  );
}
