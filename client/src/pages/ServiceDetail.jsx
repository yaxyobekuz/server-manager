import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import { useMe, can } from '../lib/useMe.js';
import { DEPLOY_STATUS } from '../lib/format.js';
import DeploymentsTab from '../components/tabs/DeploymentsTab.jsx';
import VariablesTab from '../components/tabs/VariablesTab.jsx';
import MetricsTab from '../components/tabs/MetricsTab.jsx';
import StaticMetricsTab from '../components/tabs/StaticMetricsTab.jsx';
import DomainsTab from '../components/tabs/DomainsTab.jsx';
import LogsTab from '../components/tabs/LogsTab.jsx';
import TerminalTab from '../components/tabs/TerminalTab.jsx';
import SettingsTab from '../components/tabs/SettingsTab.jsx';

// perm: the tab is hidden (and its API is blocked server-side) without it.
const TABS = [
  { key: 'deployments', label: 'Deployments', icon: Icon.rocket },
  { key: 'variables', label: 'Variables', icon: Icon.vars, perm: 'variables' },
  { key: 'metrics', label: 'Metrics', icon: Icon.cpu, perm: 'metrics' },
  { key: 'logs', label: 'Logs', icon: Icon.list, perm: 'logs' },
  { key: 'domains', label: 'Domains', icon: Icon.globe, perm: 'domainsService' },
  { key: 'settings', label: 'Settings', icon: Icon.settings, perm: 'editServices' },
];

export default function ServiceDetail() {
  // The active tab lives in the URL (/projects/:id/services/:serviceId/:tab)
  // so every tab is its own page: refresh, back/forward and direct links work.
  const { id, serviceId, tab: tabParam } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe();
  const [deploying, setDeploying] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [runError, setRunError] = useState('');

  const tabPath = (key) => `/projects/${id}/services/${serviceId}/${key}`;

  const { data } = useQuery({
    queryKey: ['service', serviceId],
    queryFn: () => api.service(serviceId),
  });
  const service = data?.service;
  const projectName = data?.projectName || '';
  const pm2Status = data?.pm2Status || null; // null = no process yet (or static)

  // Tabs push updated service rows here (Settings save, domain add, ...).
  const setService = (updated) =>
    queryClient.setQueryData(['service', serviceId], (old) => ({ ...old, service: updated }));

  const deploy = async () => {
    setDeploying(true);
    try {
      await api.deploy(serviceId, 'manual');
      navigate(tabPath('deployments'));
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['service', serviceId] });
        queryClient.invalidateQueries({ queryKey: ['deployments', serviceId] });
      }, 500);
    } finally {
      setTimeout(() => setDeploying(false), 800);
    }
  };

  const toggleRun = async () => {
    setToggling(true);
    setRunError('');
    try {
      if (pm2Status === 'online') await api.stopService(serviceId);
      else await api.startService(serviceId);
      await queryClient.invalidateQueries({ queryKey: ['service', serviceId] });
    } catch (e) {
      setRunError(e.message);
    } finally {
      setToggling(false);
    }
  };

  if (!service) return <div className="p-8 text-muted">Loading…</div>;
  const st = DEPLOY_STATUS[service.latestDeployment?.status] || DEPLOY_STATUS.none;
  const SourceIcon = service.sourceType === 'github' ? Icon.github : Icon.box;
  // Static sites have no pm2 process: runtime logs don't apply, and their
  // Metrics tab shows HTTP traffic (nginx) instead of CPU/RAM.
  const isStatic = service.serviceKind === 'static';
  const tabs = TABS.filter((t) => !(isStatic && t.key === 'logs')).filter((t) => !t.perm || can(me, t.perm));
  // 'terminal' is not in the tab bar — it opens via the header button;
  // picking any tab closes it. Unknown URL segments fall back to deployments.
  const requested = tabParam || 'deployments';
  const activeTab =
    (requested === 'terminal' && can(me, 'terminal')) || tabs.some((t) => t.key === requested)
      ? requested
      : 'deployments';

  return (
    <div className="min-h-full flex flex-col">
      <header className="px-8 pt-4 border-b border-line sticky top-0 bg-bg/90 backdrop-blur z-10">
        <div className="flex items-center gap-2 text-sm mb-3">
          <button onClick={() => navigate('/')} className="text-muted hover:text-white">Projects</button>
          <span className="text-gray-300">/</span>
          <button onClick={() => navigate(`/projects/${id}`)} className="text-muted hover:text-white truncate max-w-[200px]">
            {projectName || 'Project'}
          </button>
          <span className="text-gray-300">/</span>
          <span className="text-white">{service.name}</span>
        </div>

        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-bg-hover border border-line flex items-center justify-center text-gray-200">
              <SourceIcon width={18} height={18} />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white leading-tight">{service.name}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`chip ${st.bg} ${st.color}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${st.dot} ${['building', 'deploying'].includes(service.latestDeployment?.status) ? 'animate-pulse-dot' : ''}`} />
                  {st.label}
                </span>
                {pm2Status && pm2Status !== 'online' && (
                  <span className="chip bg-warn/10 border-warn/30 text-warn" title="Live pm2 process state">
                    process {pm2Status}
                  </span>
                )}
                <span className="text-xs text-muted font-mono">{service.repoFullName || service.localPath}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {runError && <span className="text-xs text-danger max-w-[260px] truncate" title={runError}>{runError}</span>}
            {can(me, 'terminal') && (
              <Link
                to={tabPath('terminal')}
                className={`btn-ghost ${activeTab === 'terminal' ? '!border-brand !text-white' : ''}`}
                title="Open a shell in this service's folder"
              >
                <Icon.terminal width={15} height={15} /> Terminal
              </Link>
            )}
            {!isStatic && pm2Status && can(me, 'deploy') && (
              pm2Status === 'online' ? (
                <button
                  onClick={toggleRun}
                  disabled={toggling}
                  className="btn-ghost hover:!text-danger hover:!border-danger/50"
                  title="Stop the pm2 process (saved — stays stopped across reboots)"
                >
                  <Icon.stop width={14} height={14} /> {toggling ? 'Stopping…' : 'Stop'}
                </button>
              ) : (
                <button
                  onClick={toggleRun}
                  disabled={toggling}
                  className="btn-ghost !text-ok !border-ok/40 hover:!border-ok"
                  title="Start the stopped pm2 process"
                >
                  <Icon.play width={14} height={14} /> {toggling ? 'Starting…' : 'Start'}
                </button>
              )
            )}
            {can(me, 'deploy') && (
              <button onClick={deploy} disabled={deploying} className="btn-brand">
                <Icon.rocket width={15} height={15} /> {deploying ? 'Deploying…' : 'Deploy'}
              </button>
            )}
          </div>
        </div>

        <nav className="flex gap-1 -mb-px">
          {tabs.map(({ key, label, icon: I }) => (
            <Link
              key={key}
              to={tabPath(key)}
              className={`flex items-center gap-2 px-3.5 py-2.5 text-sm border-b-2 transition ${
                activeTab === key ? 'border-brand text-white' : 'border-transparent text-muted hover:text-gray-200'
              }`}
            >
              <I width={15} height={15} /> {label}
            </Link>
          ))}
        </nav>
      </header>

      <div className="flex-1 p-8 bg-grid-fade">
        {activeTab === 'deployments' && (
          <DeploymentsTab
            service={service}
            onDeployed={() => queryClient.invalidateQueries({ queryKey: ['service', serviceId] })}
          />
        )}
        {activeTab === 'variables' && <VariablesTab serviceId={service.id} />}
        {activeTab === 'metrics' && (isStatic ? <StaticMetricsTab service={service} /> : <MetricsTab service={service} />)}
        {activeTab === 'logs' && <LogsTab service={service} />}
        {activeTab === 'terminal' && <TerminalTab service={service} />}
        {activeTab === 'domains' && <DomainsTab service={service} onChange={setService} />}
        {activeTab === 'settings' && (
          <SettingsTab
            service={service}
            onChange={setService}
            onDeleted={() => {
              queryClient.invalidateQueries({ queryKey: ['project', id] });
              queryClient.invalidateQueries({ queryKey: ['projects'] });
              navigate(`/projects/${id}`);
            }}
          />
        )}
      </div>
    </div>
  );
}
