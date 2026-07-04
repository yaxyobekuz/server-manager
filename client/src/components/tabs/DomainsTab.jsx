import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { Icon } from '../Icons.jsx';

/**
 * Map a public domain to this service, with optional certbot HTTPS.
 * Backend services proxy to their port; static services are served by nginx
 * straight from the build output directory.
 *
 * Each domain row also shows what nginx *actually* has (config present,
 * enabled, SSL terminated) — a certbot failure can leave the stored `https`
 * flag and reality apart. Repair rewrites the config and puts SSL back.
 */
export default function DomainsTab({ service, onChange }) {
  const isStatic = service.serviceKind === 'static';
  const [host, setHost] = useState('');
  const [port, setPort] = useState(service.port || '');
  const [outputDir, setOutputDir] = useState(service.staticOutputDir || '');
  const [email, setEmail] = useState('');
  const [https, setHttps] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [statuses, setStatuses] = useState({}); // host -> {confExists, enabled, ssl}
  const [repairing, setRepairing] = useState(null); // host being repaired
  const [repairMsg, setRepairMsg] = useState(null); // {host, ok, text}

  const loadStatus = () =>
    api.domainStatus(service.id)
      .then((d) => setStatuses(Object.fromEntries(d.statuses.map((s) => [s.host, s]))))
      .catch(() => {});
  useEffect(() => { loadStatus(); }, [service.id, service.domains]);

  const add = async () => {
    setBusy(true); setMsg(null);
    try {
      const payload = isStatic
        ? { host, outputDir, https, email }
        : { host, port: Number(port), https, email };
      const res = await api.addDomain(service.id, payload);
      const { service: updated } = await api.service(service.id);
      onChange(updated);
      setHost('');
      if (https && res.https && !res.https.ok) {
        setMsg({ ok: false, text: `${host} added — HTTP works, but HTTPS setup failed. Click Repair on the domain to retry.` });
      } else {
        setMsg({ ok: true, text: `${host} configured${https ? ' with HTTPS' : ''}.` });
      }
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  const remove = async (h) => {
    if (!confirm(`Remove domain ${h}?`)) return;
    await api.removeDomain(service.id, h);
    const { service: updated } = await api.service(service.id);
    onChange(updated);
  };

  const repair = async (h) => {
    setRepairing(h); setRepairMsg(null);
    try {
      const res = await api.repairDomain(service.id, h);
      const failed = (res.steps || []).filter((s) => !s.ok);
      setRepairMsg(res.ok
        ? { host: h, ok: true, text: `${h} repaired — config rewritten, ${res.steps.some((s) => s.step.startsWith('https')) ? 'SSL installed, ' : ''}probe ${res.steps.at(-1)?.output}.` }
        : { host: h, ok: false, text: failed.map((s) => `${s.step} failed${s.output ? `: ${s.output}` : ''}`).join(' · ') });
    } catch (e) {
      setRepairMsg({ host: h, ok: false, text: e.message });
    } finally {
      setRepairing(null);
      loadStatus();
    }
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="card p-6">
        <h3 className="text-white font-semibold mb-1">Add a domain</h3>
        <p className="text-xs text-muted mb-4">
          {isStatic
            ? 'nginx serves the build output directly, with optional Let\'s Encrypt certificate.'
            : 'Generates an nginx reverse-proxy and (optionally) a Let\'s Encrypt certificate.'}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Domain</label>
            <input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="app.example.com" />
          </div>
          {isStatic ? (
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Build path (in project)</label>
              <input className="input font-mono text-xs" value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder="dist" />
            </div>
          ) : (
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Port</label>
              <input className="input" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3000" />
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Email (certbot)</label>
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <label className="flex items-end gap-2 text-sm text-gray-300 pb-2">
            <input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} className="accent-brand w-4 h-4" />
            Enable HTTPS (certbot)
          </label>
        </div>
        {msg && <p className={`text-sm mt-3 ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</p>}
        <div className="flex justify-end mt-4">
          <button onClick={add} disabled={busy || !host || (!isStatic && !port)} className="btn-brand">
            <Icon.globe width={15} height={15} /> {busy ? 'Configuring…' : 'Add domain'}
          </button>
        </div>
      </div>

      <div className="card p-6">
        <h3 className="text-white font-semibold mb-4">Domains</h3>
        <div className="space-y-2">
          {(service.domains || []).length === 0 && <p className="text-sm text-muted">No domains yet.</p>}
          {(service.domains || []).map((d) => {
            const stat = statuses[d.host];
            const sslBroken = d.https && stat && !stat.ssl;
            const confBroken = stat && (!stat.confExists || !stat.enabled);
            return (
              <div key={d.host} className="bg-bg-input border border-line rounded-lg px-3.5 py-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon.globe width={15} height={15} className="text-brand shrink-0" />
                    <a href={`${d.https ? 'https' : 'http'}://${d.host}`} target="_blank" rel="noreferrer" className="text-sm text-white hover:text-brand font-mono truncate">
                      {d.https ? 'https' : 'http'}://{d.host}
                    </a>
                    <span className="text-xs text-muted shrink-0">→ {d.root || `:${d.port}`}</span>
                    {confBroken && <span className="chip bg-danger/10 border-danger/30 text-danger shrink-0">config missing</span>}
                    {!confBroken && sslBroken && <span className="chip bg-danger/10 border-danger/30 text-danger shrink-0">SSL broken</span>}
                    {!confBroken && !sslBroken && d.https && <span className="chip bg-ok/10 border-ok/30 text-ok shrink-0">SSL</span>}
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-3">
                    <button
                      onClick={() => repair(d.host)}
                      disabled={repairing === d.host}
                      className={`flex items-center gap-1.5 text-xs ${sslBroken || confBroken ? 'text-warn hover:text-white' : 'text-muted hover:text-white'}`}
                      title="Rewrite nginx config and re-install SSL"
                    >
                      <Icon.restart className={repairing === d.host ? 'animate-spin' : ''} />
                      {repairing === d.host ? 'Repairing…' : 'Repair'}
                    </button>
                    <button onClick={() => remove(d.host)} className="text-muted hover:text-danger"><Icon.trash /></button>
                  </div>
                </div>
                {repairMsg?.host === d.host && (
                  <p className={`text-xs mt-2 ${repairMsg.ok ? 'text-ok' : 'text-danger'} whitespace-pre-wrap`}>{repairMsg.text}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
