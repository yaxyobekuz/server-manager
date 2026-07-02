import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import { DEPLOY_STATUS } from '../lib/format.js';
import DeploymentsTab from '../components/tabs/DeploymentsTab.jsx';
import VariablesTab from '../components/tabs/VariablesTab.jsx';
import MetricsTab from '../components/tabs/MetricsTab.jsx';
import DomainsTab from '../components/tabs/DomainsTab.jsx';
import LogsTab from '../components/tabs/LogsTab.jsx';
import SettingsTab from '../components/tabs/SettingsTab.jsx';

const TABS = [
  { key: 'deployments', label: 'Deployments', icon: Icon.rocket },
  { key: 'variables', label: 'Variables', icon: Icon.vars },
  { key: 'metrics', label: 'Metrics', icon: Icon.cpu },
  { key: 'logs', label: 'Logs', icon: Icon.list },
  { key: 'domains', label: 'Domains', icon: Icon.globe },
  { key: 'settings', label: 'Settings', icon: Icon.settings },
];

export default function ServiceDetail() {
  const { id, serviceId } = useParams();
  const navigate = useNavigate();
  const [service, setService] = useState(null);
  const [tab, setTab] = useState('deployments');
  const [deploying, setDeploying] = useState(false);

  const load = () => api.service(serviceId).then((d) => setService(d.service)).catch(() => {});
  useEffect(() => { load(); }, [serviceId]);

  const deploy = async () => {
    setDeploying(true);
    try {
      await api.deploy(serviceId, 'manual');
      setTab('deployments');
      setTimeout(load, 500);
    } finally {
      setTimeout(() => setDeploying(false), 800);
    }
  };

  if (!service) return <div className="p-8 text-muted">Loading…</div>;
  const st = DEPLOY_STATUS[service.latestDeployment?.status] || DEPLOY_STATUS.none;
  const SourceIcon = service.sourceType === 'github' ? Icon.github : Icon.box;
  // Static sites have no pm2 process — metrics and runtime logs don't apply.
  const isStatic = service.serviceKind === 'static';
  const tabs = isStatic ? TABS.filter((t) => !['metrics', 'logs'].includes(t.key)) : TABS;
  const activeTab = tabs.some((t) => t.key === tab) ? tab : 'deployments';

  return (
    <div className="min-h-full flex flex-col">
      <header className="px-8 pt-4 border-b border-line sticky top-0 bg-bg/90 backdrop-blur z-10">
        <div className="flex items-center gap-2 text-sm mb-3">
          <button onClick={() => navigate('/')} className="text-muted hover:text-white">Projects</button>
          <span className="text-line">/</span>
          <button onClick={() => navigate(`/projects/${id}`)} className="text-muted hover:text-white">Project</button>
          <span className="text-line">/</span>
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
                <span className="text-xs text-muted font-mono">{service.repoFullName || service.localPath}</span>
              </div>
            </div>
          </div>
          <button onClick={deploy} disabled={deploying} className="btn-brand">
            <Icon.rocket width={15} height={15} /> {deploying ? 'Deploying…' : 'Deploy'}
          </button>
        </div>

        <nav className="flex gap-1 -mb-px">
          {tabs.map(({ key, label, icon: I }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 px-3.5 py-2.5 text-sm border-b-2 transition ${
                activeTab === key ? 'border-brand text-white' : 'border-transparent text-muted hover:text-gray-200'
              }`}
            >
              <I width={15} height={15} /> {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex-1 p-8 bg-grid-fade">
        {activeTab === 'deployments' && <DeploymentsTab service={service} onDeployed={load} />}
        {activeTab === 'variables' && <VariablesTab serviceId={service.id} />}
        {activeTab === 'metrics' && <MetricsTab service={service} />}
        {activeTab === 'logs' && <LogsTab service={service} />}
        {activeTab === 'domains' && <DomainsTab service={service} onChange={setService} />}
        {activeTab === 'settings' && <SettingsTab service={service} onChange={setService} onDeleted={() => navigate(`/projects/${id}`)} />}
      </div>
    </div>
  );
}
