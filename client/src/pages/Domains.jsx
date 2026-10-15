import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import Modal from '../components/Modal.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * Server-wide domain inventory: every nginx vhost and Let's Encrypt cert on
 * the machine, whether the panel created it or not. Attached domains link to
 * their service; unattached ones can be adopted into a service db-only — the
 * working nginx config and certificate are never touched.
 */

const isIssue = (d) =>
  !d.file ||
  (d.file && !d.enabled) ||
  (d.ssl && (!d.cert || d.cert.daysLeft <= 21)) ||
  (d.cert && d.cert.daysLeft <= 21);

const FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'active', label: 'Active', test: (d) => d.enabled },
  { key: 'attached', label: 'Attached', test: (d) => !!d.service },
  { key: 'unattached', label: 'Not attached', test: (d) => !d.service },
  { key: 'issues', label: 'Issues', test: isIssue },
];

function SslChip({ d }) {
  if (!d.ssl && !d.cert) return <span className="chip bg-bg-hover border-line text-muted shrink-0">HTTP</span>;
  if (d.ssl && d.cert) {
    const days = d.cert.daysLeft;
    const cls = days <= 7 ? 'bg-danger/10 border-danger/30 text-danger'
      : days <= 21 ? 'bg-warn/10 border-warn/30 text-warn'
      : 'bg-ok/10 border-ok/30 text-ok';
    return <span className={`chip ${cls} shrink-0`} title={`Certificate ${d.cert.name} expires ${new Date(d.cert.expiresAt).toLocaleDateString()}`}>SSL · {days}d</span>;
  }
  if (d.ssl && !d.cert) return <span className="chip bg-warn/10 border-warn/30 text-warn shrink-0">SSL · cert not found</span>;
  return <span className="chip bg-bg-hover border-line text-muted shrink-0" title="Certificate exists but the config does not use it">cert unused</span>;
}

function StateChip({ d }) {
  if (!d.file) return <span className="chip bg-danger/10 border-danger/30 text-danger shrink-0" title="Certificate exists but no nginx config">no config</span>;
  if (!d.enabled) return <span className="chip bg-warn/10 border-warn/30 text-warn shrink-0">disabled</span>;
  return <span className="chip bg-ok/10 border-ok/30 text-ok shrink-0">active</span>;
}

/** Searchable service picker — a plain <select> is useless with ~40 services. */
function ServicePicker({ options, value, onChange, suggestionId }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const selected = options.find((o) => o.id === value);
  const ql = q.trim().toLowerCase();
  const filtered = !ql ? options : options.filter((o) => o.label.toLowerCase().includes(ql));
  const pick = (id) => {
    onChange(id);
    setOpen(false);
    setQ('');
  };

  return (
    <div ref={boxRef} className="relative w-52">
      <button
        onClick={() => setOpen(!open)}
        className="input h-8 text-xs w-full flex items-center justify-between gap-2 text-left"
      >
        <span className={`truncate ${selected ? 'text-white' : 'text-muted'}`}>
          {selected ? selected.label : 'Attach to service…'}
        </span>
        <span className="text-muted shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 card p-1.5 w-64 shadow-glow">
          <div className="relative mb-1.5">
            <Icon.search width={13} height={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter' && filtered.length) pick(filtered[0].id);
              }}
              className="input h-8 text-xs pl-8"
              placeholder="Search services…"
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 && <p className="text-xs text-muted px-2.5 py-2">No service matches “{q.trim()}”.</p>}
            {filtered.map((o) => (
              <button
                key={o.id}
                onClick={() => pick(o.id)}
                className={`w-full flex items-center justify-between gap-2 text-left px-2.5 py-1.5 rounded-md text-xs transition ${
                  o.id === value ? 'bg-bg-hover text-white' : 'text-gray-300 hover:bg-bg-hover hover:text-white'
                }`}
              >
                <span className="truncate">{o.label}</span>
                {o.id === suggestionId && <span className="text-[10px] text-brand shrink-0">suggested</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Full teardown with granular choice: the admin ticks exactly what goes —
 * the nginx vhost and/or the Let's Encrypt certificate. Shared-resource
 * warnings (a config file or cert covering other hosts) are shown up front.
 */
function DeleteDomainModal({ domain, allDomains, onClose, onDeleted }) {
  const [delNginx, setDelNginx] = useState(false);
  const [delCert, setDelCert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {ok, steps} | {ok:false, error}

  const confMates = domain?.file
    ? allDomains.filter((x) => x.host !== domain.host && x.file === domain.file)
    : [];
  const certMates = domain?.cert ? domain.cert.hosts.filter((h) => h !== domain.host) : [];

  useEffect(() => {
    if (domain) {
      setDelNginx(Boolean(domain.file));
      // A cert shared with other hosts starts UNCHECKED — deleting it breaks
      // their HTTPS; ticking it despite the warning is the explicit consent.
      const shared = domain.cert ? domain.cert.hosts.some((h) => h !== domain.host) : false;
      setDelCert(Boolean(domain.cert) && !shared);
      setResult(null);
      setBusy(false);
    }
  }, [domain]);

  const doDelete = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.deleteSystemDomain(domain.host, {
        nginx: delNginx,
        cert: delCert,
        // ticking the cert box under a visible shared-cert warning is consent
        force: delCert && certMates.length > 0,
      });
      setResult(r);
      onDeleted();
    } catch (e) {
      setResult({ ok: false, error: e.message });
    } finally {
      setBusy(false);
    }
  };

  const done = result && !result.error;
  return (
    <Modal open={!!domain} onClose={busy ? () => {} : onClose} title={domain ? `Delete ${domain.host}` : ''}>
      {!done ? (
        <>
          <p className="text-xs text-muted mb-4">Choose what to remove — this cannot be undone.</p>
          <div className="space-y-3">
            <label className={`flex items-start gap-2.5 text-sm ${domain?.file ? 'text-gray-300 cursor-pointer' : 'text-muted'}`}>
              <input
                type="checkbox"
                checked={delNginx}
                disabled={!domain?.file}
                onChange={(e) => setDelNginx(e.target.checked)}
                className="accent-danger w-4 h-4 mt-0.5"
              />
              <span>
                nginx config {domain?.file ? <span className="font-mono text-xs">({domain.file})</span> : '— none exists'}
                {domain?.service && (
                  <span className="block text-xs text-muted mt-0.5">
                    Also detaches the domain from {domain.service.projectName} / {domain.service.name}.
                  </span>
                )}
                {confMates.length > 0 && (
                  <span className="block text-xs text-warn mt-0.5">
                    ⚠ This file also serves: {confMates.map((x) => x.host).join(', ')} — they stop working too.
                  </span>
                )}
              </span>
            </label>
            <label className={`flex items-start gap-2.5 text-sm ${domain?.cert ? 'text-gray-300 cursor-pointer' : 'text-muted'}`}>
              <input
                type="checkbox"
                checked={delCert}
                disabled={!domain?.cert}
                onChange={(e) => setDelCert(e.target.checked)}
                className="accent-danger w-4 h-4 mt-0.5"
              />
              <span>
                Let's Encrypt certificate{' '}
                {domain?.cert ? (
                  <span className="font-mono text-xs">({domain.cert.name}, {domain.cert.daysLeft}d left)</span>
                ) : (
                  '— none exists'
                )}
                {certMates.length > 0 && (
                  <span className="block text-xs text-warn mt-0.5">
                    ⚠ This certificate also covers: {certMates.join(', ')}.
                  </span>
                )}
                {domain?.ssl && delCert && !delNginx && (
                  <span className="block text-xs text-warn mt-0.5">
                    ⚠ The kept nginx config still references this certificate — nginx will fail to reload until the config is removed or edited.
                  </span>
                )}
              </span>
            </label>
          </div>
          {result?.error && <p className="text-sm text-danger mt-3">{result.error}</p>}
          <div className="flex justify-end gap-2 mt-6">
            <button onClick={onClose} disabled={busy} className="btn-ghost">Cancel</button>
            <button onClick={doDelete} disabled={busy || (!delNginx && !delCert)} className="btn-danger">
              <Icon.trash /> {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            {(result.steps || []).map((s, i) => (
              <p key={i} className={`text-sm ${s.ok ? 'text-ok' : 'text-danger'}`}>
                {s.ok ? '✓' : '✗'} {s.step}
                {s.output && <span className="block text-xs text-muted whitespace-pre-wrap ml-4">{s.output}</span>}
              </p>
            ))}
          </div>
          <div className="flex justify-end mt-6">
            <button onClick={onClose} className="btn-brand">Close</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Tile({ label, value, tone = 'text-white' }) {
  return (
    <div className="card px-4 py-3">
      <div className={`text-xl font-semibold ${tone}`}>{value}</div>
      <div className="text-xs text-muted mt-0.5">{label}</div>
    </div>
  );
}

export default function Domains() {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState({}); // host → serviceId chosen in the attach select
  const [busyHost, setBusyHost] = useState(null);
  const [err, setErr] = useState(null); // {host, text}
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(null); // domain entry being deleted
  const queryClient = useQueryClient();

  const { data, error: loadError } = useQuery({
    queryKey: ['sys', 'domains'],
    queryFn: () => api.systemDomains(),
    refetchInterval: 120_000,
  });
  const { data: projectsData } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const serviceOptions = (projectsData?.projects || []).flatMap((p) =>
    (p.services || []).map((s) => ({ id: s.id, label: `${p.name} / ${s.name}` }))
  );

  const domains = data?.domains || [];
  const counts = data?.counts || {};

  const q = query.trim().toLowerCase();
  const visible = domains
    .filter(FILTERS.find((f) => f.key === filter).test)
    .filter(
      (d) =>
        !q ||
        d.host.toLowerCase().includes(q) ||
        (d.file || '').toLowerCase().includes(q) ||
        (d.service && `${d.service.projectName} ${d.service.name}`.toLowerCase().includes(q))
    );

  const filterCounts = Object.fromEntries(FILTERS.map((f) => [f.key, domains.filter(f.test).length]));

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await api.systemDomains(true);
      queryClient.setQueryData(['sys', 'domains'], fresh);
    } finally {
      setRefreshing(false);
    }
  };

  const adopt = async (host) => {
    const serviceId = sel[host] ?? domains.find((d) => d.host === host)?.suggestion?.serviceId;
    if (!serviceId) return;
    setBusyHost(host);
    setErr(null);
    try {
      await api.adoptDomain(serviceId, host);
      queryClient.invalidateQueries({ queryKey: ['sys', 'domains'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['service', serviceId] });
      queryClient.invalidateQueries({ queryKey: ['domainStatus', serviceId] });
    } catch (e) {
      setErr({ host, text: e.message });
    } finally {
      setBusyHost(null);
    }
  };

  return (
    <div className="bg-grid-fade min-h-full">
      <header className="flex items-center justify-between gap-4 px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <h1 className="text-[15px] font-semibold text-white shrink-0">Domains</h1>
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative w-64 max-w-full">
            <Icon.search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              className="input h-9 pl-9 pr-3 text-sm"
              placeholder="Find a domain…"
            />
          </div>
          <button onClick={refresh} disabled={refreshing} className="btn-ghost shrink-0" title="Re-scan nginx and certbot">
            <Icon.restart className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      </header>

      <div className="p-8">
        {loadError && <div className="mb-4 chip bg-danger/10 border-danger/30 text-danger">{loadError.message}</div>}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          <Tile label="All domains" value={counts.total ?? '—'} />
          <Tile label="Active (enabled)" value={counts.active ?? '—'} tone="text-ok" />
          <Tile label="HTTPS working" value={counts.https ?? '—'} tone="text-ok" />
          <Tile label="Attached to services" value={counts.attached ?? '—'} />
          <Tile label="Not attached" value={counts.unattached ?? '—'} tone={counts.unattached ? 'text-warn' : 'text-white'} />
          <Tile label="Cert expiring ≤21d" value={counts.expiring ?? '—'} tone={counts.expiring ? 'text-warn' : 'text-white'} />
        </div>

        <div className="flex items-center justify-between mb-4">
          <div className="flex bg-bg-input border border-line rounded-lg p-0.5 text-xs">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-2.5 py-1 rounded ${filter === f.key ? 'bg-bg-hover text-white' : 'text-muted hover:text-gray-200'}`}
              >
                {f.label} <span className="opacity-60">{filterCounts[f.key] ?? 0}</span>
              </button>
            ))}
          </div>
          {data?.scannedAt && <span className="text-xs text-muted">scanned {timeAgo(data.scannedAt)}</span>}
        </div>

        <div className="space-y-2">
          {visible.length === 0 && (
            <div className="card p-10 text-center text-sm text-muted">Nothing here — change the filter or search.</div>
          )}
          {visible.map((d) => (
            <div key={d.host} className="card px-4 py-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <Icon.globe width={15} height={15} className="text-brand shrink-0" />
                  <a
                    href={`${d.ssl ? 'https' : 'http'}://${d.host}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-white hover:text-brand font-mono truncate"
                  >
                    {d.host}
                  </a>
                  <StateChip d={d} />
                  <SslChip d={d} />
                  {d.file && !d.managed && (
                    <span className="chip bg-bg-hover border-line text-muted shrink-0" title={`Hand-written config: ${d.file}`}>external conf</span>
                  )}
                  <span className="text-xs text-muted font-mono truncate hidden md:inline" title={d.file ? `/etc/nginx/sites-available/${d.file}` : ''}>
                    {d.root ? `→ ${d.root}` : d.port ? `→ :${d.port}` : ''}
                  </span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {d.service ? (
                    <Link
                      to={`/projects/${d.service.projectId}/services/${d.service.id}/domains`}
                      className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-brand transition"
                    >
                      <Icon.box width={13} height={13} className="text-brand" />
                      {d.service.projectName} / {d.service.name}
                    </Link>
                  ) : (
                    <>
                      <ServicePicker
                        options={serviceOptions}
                        value={sel[d.host] ?? d.suggestion?.serviceId ?? ''}
                        onChange={(id) => setSel({ ...sel, [d.host]: id })}
                        suggestionId={d.suggestion?.serviceId}
                      />
                      <button
                        onClick={() => adopt(d.host)}
                        disabled={busyHost === d.host || !(sel[d.host] ?? d.suggestion?.serviceId) || !d.file}
                        className="btn-brand h-8 text-xs px-3"
                        title="Link this domain to the service — nginx and certbot configs stay untouched"
                      >
                        {busyHost === d.host ? 'Attaching…' : 'Attach'}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => setDeleting(d)}
                    className="p-1.5 rounded-md text-muted hover:text-danger hover:bg-bg-hover transition"
                    title="Delete domain — nginx config and/or certificate"
                  >
                    <Icon.trash />
                  </button>
                </div>
              </div>
              {!d.service && d.suggestion && !sel[d.host] && (
                <p className="text-[11px] text-muted mt-1.5 ml-7">
                  suggested: {d.suggestion.projectName} / {d.suggestion.serviceName} (port match)
                </p>
              )}
              {err?.host === d.host && <p className="text-xs text-danger mt-1.5 ml-7">{err.text}</p>}
            </div>
          ))}
        </div>
      </div>

      <DeleteDomainModal
        domain={deleting}
        allDomains={domains}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          queryClient.invalidateQueries({ queryKey: ['sys', 'domains'] });
          queryClient.invalidateQueries({ queryKey: ['projects'] });
          if (deleting?.service) {
            queryClient.invalidateQueries({ queryKey: ['service', deleting.service.id] });
            queryClient.invalidateQueries({ queryKey: ['domainStatus', deleting.service.id] });
          }
        }}
      />
    </div>
  );
}
