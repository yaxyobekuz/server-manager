const TOKEN_KEY = 'sm_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  login: (password) => request('POST', '/login', { password }),
  me: () => request('GET', '/me'),

  // Admins (owner only)
  admins: () => request('GET', '/admins'),
  adminPermissions: () => request('GET', '/admins/permissions'),
  createAdmin: (a) => request('POST', '/admins', a),
  updateAdmin: (id, patch) => request('PATCH', `/admins/${id}`, patch),
  deleteAdmin: (id) => request('DELETE', `/admins/${id}`),

  // Projects
  projects: () => request('GET', '/projects'),
  project: (id) => request('GET', `/projects/${id}`),
  createProject: (p) => request('POST', '/projects', p),
  updateProject: (id, p) => request('PATCH', `/projects/${id}`, p),
  copyProject: (id, payload) => request('POST', `/projects/${id}/copy`, payload),
  setProjectCreatedAt: (id, createdAt, note) => request('PUT', `/projects/${id}/created-at`, { createdAt, note }),
  deleteProject: (id) => request('DELETE', `/projects/${id}`),
  projectProcesses: (id) => request('GET', `/projects/${id}/processes`),
  stopProject: (id) => request('POST', `/projects/${id}/stop`),
  startProject: (id) => request('POST', `/projects/${id}/start`),

  // Services
  service: (id) => request('GET', `/services/${id}`),
  createService: (s) => request('POST', '/services', s),
  updateService: (id, s) => request('PATCH', `/services/${id}`, s),
  setServiceCreatedAt: (id, createdAt, note) => request('PUT', `/services/${id}/created-at`, { createdAt, note }),
  deleteService: (id) => request('DELETE', `/services/${id}`),
  deploy: (id, trigger) => request('POST', `/services/${id}/deploy`, { trigger }),
  stopService: (id) => request('POST', `/services/${id}/stop`),
  startService: (id) => request('POST', `/services/${id}/start`),
  deployments: (id) => request('GET', `/services/${id}/deployments`),
  deployment: (id, depId) => request('GET', `/services/${id}/deployments/${depId}`),
  variables: (id) => request('GET', `/services/${id}/variables`),
  saveVariables: (id, variables) => request('PUT', `/services/${id}/variables`, { variables }),
  gitStatus: (id) => request('GET', `/services/${id}/git`),
  metrics: (id) => request('GET', `/services/${id}/metrics`),
  metricsMonth: (id, month) => request('GET', `/services/${id}/metrics/history?month=${encodeURIComponent(month)}`),
  traffic: (id) => request('GET', `/services/${id}/traffic`),
  trafficMonth: (id, month) => request('GET', `/services/${id}/traffic/history?month=${encodeURIComponent(month)}`),
  addDomain: (id, payload) => request('POST', `/services/${id}/domains`, payload),
  adoptDomain: (id, host) => request('POST', `/services/${id}/domains/adopt`, { host }),
  removeDomain: (id, host, keep) =>
    request('DELETE', `/services/${id}/domains/${encodeURIComponent(host)}${keep ? '?keep=1' : ''}`),
  domainStatus: (id) => request('GET', `/services/${id}/domains/status`),
  repairDomain: (id, host) => request('POST', `/services/${id}/domains/${encodeURIComponent(host)}/repair`),

  // System
  systemStats: () => request('GET', '/system/stats'),
  systemDomains: (refresh) => request('GET', `/system/domains${refresh ? '?refresh=1' : ''}`),
  deleteSystemDomain: (host, { nginx, cert, force }) =>
    request('DELETE', `/system/domains/${encodeURIComponent(host)}?nginx=${nginx ? 1 : 0}&cert=${cert ? 1 : 0}${force ? '&force=1' : ''}`),
  systemOverview: () => request('GET', '/system/overview'),
  systemHistory: (month) => request('GET', `/system/history?month=${encodeURIComponent(month)}`),
  systemProjects: (month) =>
    request('GET', `/system/projects${month && month !== 'live' ? `?month=${encodeURIComponent(month)}` : ''}`),
  systemStorage: () => request('GET', '/system/storage'),
  systemInfo: () => request('GET', '/system/info'),
  speedtest: (phase) => request('POST', `/system/speedtest/${phase}`),
  processes: () => request('GET', '/system/processes'),
  processAction: (id, action) => request('POST', `/system/processes/${id}/${action}`),
};
