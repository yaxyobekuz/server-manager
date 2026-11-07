/**
 * The tools the panel offers over MCP.
 *
 * Every tool goes through `api`, which is the panel's own HTTP API — the same
 * endpoints the web UI calls, so a tool can never reach past the permissions
 * of the identity it runs as, and there is no second copy of the rules to
 * keep in step. `api(method, path, body)` is injected: the HTTP transport
 * passes one that loops back to this process, and any other host could pass
 * one that goes over the network.
 *
 * Output is trimmed on purpose. The raw rows carry .env copies and whole
 * deployment logs, and a model reading them would lose the answer in the
 * noise.
 */

export function createTools(api) {
  /* ------------------------------------------------------- naming services */

  /** Find a service by id, by "Project/service", by pm2 name, or by bare name. */
  async function resolveService(ref) {
    const raw = String(ref ?? '').trim();
    if (!raw) throw new Error('Which service? Use "Project/service" — list_projects shows them all.');

    const { projects } = await api('GET', '/projects');
    const all = [];
    for (const p of projects) {
      for (const s of p.services || []) all.push({ project: p, service: s, ref: `${p.name}/${s.name}` });
    }
    const byId = all.find((e) => e.service.id === raw);
    if (byId) return byId;

    const needle = raw.toLowerCase();
    const hits = all.filter(
      (e) =>
        e.ref.toLowerCase() === needle ||
        e.service.name.toLowerCase() === needle ||
        (e.service.pm2Name || '').toLowerCase() === needle
    );
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new Error(`"${raw}" matches ${hits.map((h) => h.ref).join(', ')} — name it as "Project/service".`);
    }
    throw new Error(`No service called "${raw}". list_projects shows what exists.`);
  }

  async function resolveProject(ref) {
    const raw = String(ref ?? '').trim();
    const { projects } = await api('GET', '/projects');
    const hit =
      projects.find((p) => p.id === raw) || projects.find((p) => p.name.toLowerCase() === raw.toLowerCase());
    if (!hit) throw new Error(`No project called "${raw}". list_projects shows what exists.`);
    return hit;
  }

  /* ----------------------------------------------------------- compact views
   * Tool output is read by a model, so it is trimmed on purpose: the raw rows
   * carry .env copies and whole deployment logs, which would bury the answer.
   */

  const serviceBrief = (p, s, procByName = {}) => ({
    ref: `${p.name}/${s.name}`,
    id: s.id,
    kind: s.serviceKind === 'static' ? 'static' : s.sourceType === 'github' ? 'github' : 'local',
    repo: s.repoFullName || s.repoUrl || null,
    branch: s.branch || null,
    port: s.port || null,
    pm2: s.pm2Name || s.name,
    status: procByName[s.pm2Name || s.name]?.status || null,
    autoDeploy: Boolean(s.autoDeploy),
    domains: (s.domains || []).map((d) => d.host || d),
    path: s.localPath || null,
  });

  const deploymentBrief = (d) => ({
    id: d.id,
    status: d.status,
    trigger: d.trigger,
    commit: d.commit || null,
    startedAt: d.createdAt,
    finishedAt: d.finishedAt,
    lines: (d.logs || []).length,
  });

  const logTail = (d, lines) =>
    (d.logs || [])
      .slice(-lines)
      .map((l) => `${l.stream === 'stderr' ? '! ' : ''}${l.line}`)
      .join('\n');

  /* ------------------------------------------------------------------ tools */

  const S = {
    service: {
      type: 'string',
      description: 'Service as "Project/service" (e.g. "E Murojaat/server"), or its id or pm2 name.',
    },
  };

  const tools = [
    /* ---------------------------------------------------------------- read */
    {
      name: 'list_projects',
      description:
        'Every project on the server with its services: repo, branch, port, pm2 name, live process status, domains and whether auto-deploy is on. Start here — other tools name services as "Project/service".',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      async run() {
        const { projects } = await api('GET', '/projects');
        // Live status is a bonus: an admin without the Processes permission
        // still gets the list, just without it.
        let procByName = {};
        try {
          const { processes } = await api('GET', '/system/processes');
          procByName = Object.fromEntries((processes || []).map((p) => [p.name, p]));
        } catch {
          /* no permission — statuses stay null */
        }
        return projects.map((p) => ({
          project: p.name,
          id: p.id,
          path: p.path,
          services: (p.services || []).map((s) => serviceBrief(p, s, procByName)),
        }));
      },
    },
    {
      name: 'get_service',
      description:
        'Everything about one service: build/start commands, port, env var NAMES (not values), domains, pm2 status, the last deployment and the checked-out commit.',
      inputSchema: { type: 'object', properties: { service: S.service }, required: ['service'] },
      readOnly: true,
      async run({ service: ref }) {
        const { project, service } = await resolveService(ref);
        const [detail, git] = await Promise.all([
          api('GET', `/services/${service.id}`),
          api('GET', `/services/${service.id}/git`).catch(() => ({ status: null })),
        ]);
        const s = detail.service;
        return {
          ref: `${project.name}/${s.name}`,
          id: s.id,
          project: project.name,
          kind: s.serviceKind || 'auto',
          source: s.sourceType === 'github' ? { repo: s.repoFullName || s.repoUrl, branch: s.branch } : { localPath: s.localPath },
          rootDirectory: s.rootDirectory || null,
          buildCommand: s.buildCommand || null,
          startCommand: s.startCommand || null,
          staticOutputDir: s.staticOutputDir || null,
          port: s.port || null,
          pm2: s.pm2Name || s.name,
          pm2Status: detail.pm2Status,
          autoDeploy: Boolean(s.autoDeploy),
          domains: (s.domains || []).map((d) => ({ host: d.host || d, ssl: d.ssl ?? null })),
          variableNames: Object.keys(s.variables || {}),
          checkedOut: git.status || null,
          lastDeployment: s.latestDeployment ? deploymentBrief(s.latestDeployment) : null,
          deploymentCount: s.deploymentCount ?? null,
        };
      },
    },
    {
      name: 'list_deployments',
      description: 'Recent deployments of a service: status, trigger, commit and timing. Newest first.',
      inputSchema: {
        type: 'object',
        properties: { service: S.service, limit: { type: 'number', description: 'How many (default 10).' } },
        required: ['service'],
      },
      readOnly: true,
      async run({ service: ref, limit = 10 }) {
        const { service } = await resolveService(ref);
        const { deployments } = await api('GET', `/services/${service.id}/deployments`);
        return deployments.slice(0, Math.min(Math.max(limit, 1), 50)).map(deploymentBrief);
      },
    },
    {
      name: 'get_deployment',
      description: 'One deployment with its build log — use this to find out why a deploy failed.',
      inputSchema: {
        type: 'object',
        properties: {
          service: S.service,
          deployment: { type: 'string', description: 'Deployment id, or "last" for the most recent.' },
          lines: { type: 'number', description: 'Log lines from the end (default 120).' },
        },
        required: ['service'],
      },
      readOnly: true,
      async run({ service: ref, deployment = 'last', lines = 120 }) {
        const { service } = await resolveService(ref);
        let depId = deployment;
        if (!depId || depId === 'last') {
          const { deployments } = await api('GET', `/services/${service.id}/deployments`);
          if (!deployments.length) throw new Error('This service has never been deployed.');
          depId = deployments[0].id;
        }
        const { deployment: d } = await api('GET', `/services/${service.id}/deployments/${depId}`);
        return { ...deploymentBrief(d), log: logTail(d, Math.min(Math.max(lines, 1), 1000)) };
      },
    },
    {
      name: 'get_logs',
      description:
        "A service's runtime logs as the app is writing them now, stdout and stderr kept apart. This is the app's own output, not the build log.",
      inputSchema: {
        type: 'object',
        properties: { service: S.service, lines: { type: 'number', description: 'Lines per stream (default 60).' } },
        required: ['service'],
      },
      readOnly: true,
      async run({ service: ref, lines = 60 }) {
        const { service } = await resolveService(ref);
        const n = Math.min(Math.max(lines, 1), 500);
        const data = await api('GET', `/services/${service.id}/logs?lines=${n}`);
        if (!data.found) return { note: `No pm2 process "${data.pm2Name}" — the service has not been deployed.` };
        return { pm2: data.pm2Name, status: data.status, stdout: data.out.join('\n'), stderr: data.err.join('\n') };
      },
    },
    {
      name: 'get_variables',
      description:
        "A service's environment variables from its .env file, values included. Needs the Variables permission.",
      inputSchema: { type: 'object', properties: { service: S.service }, required: ['service'] },
      readOnly: true,
      async run({ service: ref }) {
        const { service } = await resolveService(ref);
        return api('GET', `/services/${service.id}/variables`);
      },
    },
    {
      name: 'list_domains',
      description: 'Every domain nginx serves on this box, what it points at, and whether HTTPS is in place.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: () => api('GET', '/system/domains'),
    },
    {
      name: 'list_processes',
      description: 'All pm2 processes on the server with status, cpu, memory, uptime and restart count.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      async run() {
        const { processes } = await api('GET', '/system/processes');
        return (processes || []).map((p) => ({
          name: p.name,
          status: p.status,
          pid: p.pid,
          cpu: p.cpu,
          memoryMb: p.memory ? Math.round(p.memory / 1048576) : null,
          // pm2 reports pm_uptime: the epoch ms it STARTED at, not a duration.
          startedAt: p.uptime ? new Date(p.uptime).toISOString() : null,
          uptimeSeconds: p.uptime ? Math.round((Date.now() - p.uptime) / 1000) : null,
          restarts: p.restarts,
        }));
      },
    },
    {
      name: 'server_info',
      description: 'The machine: CPU, memory, disk, OS, installed runtime versions, and the panel\'s own counts.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: () => api('GET', '/system/info'),
    },

    /* --------------------------------------------------------------- write */
    {
      name: 'deploy_service',
      description:
        'Deploy a service: pull the branch, build, and restart it. Waits for the result by default and returns the final status with the tail of the build log, so a failure comes back explained.',
      inputSchema: {
        type: 'object',
        properties: {
          service: S.service,
          wait: { type: 'boolean', description: 'Wait for it to finish (default true).' },
          timeoutSeconds: { type: 'number', description: 'How long to wait (default 600).' },
        },
        required: ['service'],
      },
      async run({ service: ref, wait = true, timeoutSeconds = 600 }) {
        const { project, service } = await resolveService(ref);
        const { deployment } = await api('POST', `/services/${service.id}/deploy`, { trigger: 'manual' });
        const started = { ref: `${project.name}/${service.name}`, deploymentId: deployment.id };
        if (!wait) return { ...started, status: deployment.status, note: 'Started. Use get_deployment to follow it.' };

        const deadline = Date.now() + Math.min(Math.max(timeoutSeconds, 10), 1800) * 1000;
        let last = deployment;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const res = await api('GET', `/services/${service.id}/deployments/${deployment.id}`);
          last = res.deployment;
          if (last.status !== 'building' && last.status !== 'deploying') break;
        }
        const finished = last.status !== 'building' && last.status !== 'deploying';
        return {
          ...started,
          status: last.status,
          ...(finished ? {} : { note: 'Still running — it outlasted the wait, use get_deployment to follow it.' }),
          commit: last.commit || null,
          log: logTail(last, last.status === 'success' ? 25 : 120),
        };
      },
    },
    {
      name: 'restart_service',
      description: "Restart a service's pm2 process without rebuilding. Needs the Process actions permission.",
      inputSchema: { type: 'object', properties: { service: S.service }, required: ['service'] },
      async run({ service: ref }) {
        const { project, service } = await resolveService(ref);
        const name = service.pm2Name || service.name;
        await api('POST', `/system/processes/${encodeURIComponent(name)}/restart`);
        return { ref: `${project.name}/${service.name}`, pm2: name, action: 'restart', ok: true };
      },
    },
    {
      name: 'stop_service',
      description: "Stop a service's pm2 process. The state is saved, so it stays stopped across a reboot.",
      inputSchema: { type: 'object', properties: { service: S.service }, required: ['service'] },
      async run({ service: ref }) {
        const { service } = await resolveService(ref);
        return api('POST', `/services/${service.id}/stop`);
      },
    },
    {
      name: 'start_service',
      description: "Start a service's pm2 process again after it was stopped.",
      inputSchema: { type: 'object', properties: { service: S.service }, required: ['service'] },
      async run({ service: ref }) {
        const { service } = await resolveService(ref);
        return api('POST', `/services/${service.id}/start`);
      },
    },
    {
      name: 'set_variables',
      description:
        "Change environment variables in a service's .env. By default the given keys are merged into what is there; set replace: true to make the file exactly these keys. A null value deletes a key. The app only picks the change up on its next deploy or restart.",
      inputSchema: {
        type: 'object',
        properties: {
          service: S.service,
          variables: { type: 'object', description: 'KEY: value pairs. null deletes that key.' },
          replace: { type: 'boolean', description: 'Replace the whole set instead of merging (default false).' },
        },
        required: ['service', 'variables'],
      },
      async run({ service: ref, variables, replace = false }) {
        if (!variables || typeof variables !== 'object') throw new Error('variables must be an object of KEY: value');
        const { service } = await resolveService(ref);
        let next = { ...variables };
        if (!replace) {
          const current = await api('GET', `/services/${service.id}/variables`);
          next = { ...(current.variables || {}), ...variables };
        }
        for (const [k, v] of Object.entries(next)) {
          if (v === null) delete next[k];
          else next[k] = String(v);
        }
        const saved = await api('PUT', `/services/${service.id}/variables`, { variables: next });
        return {
          keys: Object.keys(saved.variables || {}),
          changed: Object.keys(variables),
          writtenTo: saved.path || saved.source,
          note: 'Deploy or restart the service for the app to see this.',
        };
      },
    },
    {
      name: 'deploy_project',
      description: 'Deploy every github-backed service in a project, one after another, and report each result.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name or id.' },
          wait: { type: 'boolean', description: 'Wait for each one (default true).' },
        },
        required: ['project'],
      },
      async run({ project: ref, wait = true }) {
        const project = await resolveProject(ref);
        const services = (project.services || []).filter((s) => s.sourceType === 'github');
        if (!services.length) return { project: project.name, note: 'No github-backed services to deploy.' };
        const results = [];
        for (const s of services) {
          try {
            const r = await tools
              .find((t) => t.name === 'deploy_service')
              .run({ service: s.id, wait, timeoutSeconds: 600 });
            results.push({ service: s.name, status: r.status, deploymentId: r.deploymentId });
          } catch (err) {
            results.push({ service: s.name, status: 'error', error: err.message });
          }
        }
        return { project: project.name, results };
      },
    },
    {
      name: 'add_domain',
      description:
        'Point a domain at a service: writes the nginx vhost and issues HTTPS when this server terminates TLS itself. The DNS record must already exist.',
      inputSchema: {
        type: 'object',
        properties: {
          service: S.service,
          host: { type: 'string', description: 'The hostname, e.g. api.example.com' },
          https: { type: 'boolean', description: 'Try to issue a certificate (default true).' },
        },
        required: ['service', 'host'],
      },
      async run({ service: ref, host, https = true }) {
        const { service } = await resolveService(ref);
        return api('POST', `/services/${service.id}/domains`, { host, https });
      },
    },

    /* --------------------------------------------------------- the panel */
    {
      name: 'panel_status',
      description:
        'The Deploy panel itself: the commit it runs, whether its repo has moved on, whether auto-update is on, and how the last self-update went.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      async run() {
        const [state, check] = await Promise.all([
          api('GET', '/panel?logLines=0'),
          api('GET', '/panel/check').catch((e) => ({ error: e.message })),
        ]);
        return {
          version: state.repo.version,
          branch: state.repo.branch,
          repo: state.repo.repoFullName,
          commit: state.repo.commit,
          localChanges: state.repo.localChanges,
          autoUpdate: state.settings.selfUpdateAuto,
          remote: check,
          lastUpdate: state.job
            ? { status: state.job.status, step: state.job.step, trigger: state.job.trigger, error: state.job.error }
            : null,
        };
      },
    },
    {
      name: 'update_panel',
      description:
        'Update the Deploy panel itself to the latest commit of its own repo and restart it. The panel goes away for a few seconds; it rolls itself back if the new version fails to come up.',
      inputSchema: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: 'Rebuild and restart even with nothing new to pull.' },
          wait: { type: 'boolean', description: 'Wait for the result (default true).' },
        },
      },
      async run({ force = false, wait = true }) {
        await api('POST', '/panel/update', { force });
        if (!wait) return { started: true, note: 'Use panel_status to see how it went.' };
        const deadline = Date.now() + 300_000;
        let job = null;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const state = await api('GET', '/panel?logLines=0');
            job = state.job;
            if (job && job.status !== 'running') break;
          } catch {
            /* the panel is restarting — that is expected here */
          }
        }
        if (!job) return { note: 'Started, but the panel did not report back in time. Check panel_status.' };
        return {
          status: job.status,
          from: job.from?.slice(0, 7) || null,
          to: job.to?.slice(0, 7) || null,
          upToDate: Boolean(job.upToDate),
          rebuilt: Boolean(job.rebuilt),
          restarted: Boolean(job.restarted),
          rolledBack: Boolean(job.rolledBack),
          error: job.error || null,
        };
      },
    },
  ];

  return tools;
}
