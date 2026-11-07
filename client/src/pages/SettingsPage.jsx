import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import { useMe, isOwner } from '../lib/useMe.js';
import PanelUpdateCard from '../components/PanelUpdateCard.jsx';
import { copyText } from '../lib/clipboard.js';

/**
 * Owner-only panel settings: updating the panel itself, and the GitHub
 * webhook credentials that both that and every project deploy run on.
 *
 * The credentials are shown in full and one click from the clipboard,
 * because the only way to wire a repo up is to paste them into GitHub by
 * hand. The owner already knows every other secret on this box (they log in
 * with ADMIN_PASSWORD), so there is nobody to hide them from — but a created
 * admin must never see them: the secret is the only thing that makes an
 * incoming push trusted, and an update replaces the code that checks it.
 */
export default function SettingsPage() {
  const me = useMe();
  const owner = isOwner(me);

  if (me && !owner) {
    return (
      <div className="p-8">
        <div className="card p-10 text-center max-w-md mx-auto mt-10 text-sm text-muted">
          Only the owner can see the panel's settings.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-grid-fade min-h-full">
      <header className="flex items-center px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <h1 className="text-[15px] font-semibold text-white">Settings</h1>
      </header>

      <div className="p-8 max-w-3xl space-y-4">
        <PanelUpdateCard enabled={owner} />
        <WebhookCard enabled={owner} />
        <McpCard enabled={owner} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------- github webhook */

function WebhookCard({ enabled }) {
  const { data, error } = useQuery({
    queryKey: ['github-webhook'],
    queryFn: api.githubWebhook,
    enabled,
    staleTime: 30_000,
  });

  if (error) {
    return (
      <div className="card p-5 text-sm text-danger">Could not load the webhook settings: {error.message}</div>
    );
  }
  if (!data) return <div className="card p-5 text-sm text-muted">Loading…</div>;

  // The panel's API always lives at the origin's /api, so whatever address
  // this page was opened at is the address GitHub has to POST to. Reading it
  // from the browser is deliberate: the server behind a proxy cannot know
  // its own public name.
  const url = `${window.location.origin}${data.path}`;

  return (
    <>
      <div className="card p-5">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <Icon.github /> GitHub webhook
        </h2>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          Paste these into a repo's <span className="text-gray-300">Settings → Webhooks → Add webhook</span>. Every
          push then auto-deploys the services bound to that repo — the same two values work for all of them, one
          webhook per repo.
        </p>

        <div className="mt-4 space-y-3">
          <CopyField label="Payload URL" value={url} />
          {data.configured ? (
            <CopyField label="Secret" value={data.secret} />
          ) : (
            <NoSecret envVar={data.envVar} envFile={data.envFile} />
          )}
          <div className="grid sm:grid-cols-2 gap-3 pt-1">
            <Fact label="Content type" value={data.contentType} />
            <Fact label="Events" value={`Just the ${data.event} event`} />
          </div>
        </div>
      </div>

      <RepoList repos={data.repos || []} />
    </>
  );
}

/** A value shown in full, with its own copy button. */
function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyText(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <div className="text-[11px] text-muted uppercase tracking-wide">{label}</div>
      <div className="mt-1.5 flex items-stretch gap-2">
        <code className="flex-1 min-w-0 rounded-lg border border-line bg-bg-input px-3 py-2 font-mono text-[13px] text-gray-200 break-all select-all whitespace-pre-wrap">
          {value}
        </code>
        <button
          onClick={copy}
          title={`Copy ${label}`}
          className={`shrink-0 self-stretch px-3 rounded-lg border text-xs font-medium transition flex items-center gap-1.5 ${
            copied
              ? 'border-ok/50 text-ok bg-ok/10'
              : 'border-line text-gray-300 hover:text-white hover:border-gray-500'
          }`}
        >
          {copied ? <Icon.check /> : <Icon.copy />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function Fact({ label, value }) {
  return (
    <div>
      <div className="text-[11px] text-muted uppercase tracking-wide">{label}</div>
      <div className="mt-1 text-[13px] text-gray-200 font-mono">{value}</div>
    </div>
  );
}

/** No secret set means every webhook is rejected — say exactly how to fix it. */
function NoSecret({ envVar, envFile }) {
  const snippet = `echo "${envVar}=$(openssl rand -hex 32)" >> ${envFile} && pm2 restart server-manager`;
  return (
    <div>
      <div className="text-[11px] text-warn uppercase tracking-wide">Secret — not set</div>
      <p className="text-xs text-muted mt-1 mb-1.5 leading-relaxed">
        Without it every incoming webhook is rejected with <span className="font-mono text-gray-300">401</span>. Run
        this once on the server, then reload this page and the secret appears here.
      </p>
      <CopyField label="Run on the server" value={snippet} />
    </div>
  );
}

/* ------------------------------------------------------------- claude mcp */

/**
 * MCP access: one URL that Claude Desktop or Claude Code connects to, so the
 * user installs nothing. The key in that URL is the whole authentication, so
 * the card says what it can do and keeps revoking one click away.
 */
function McpCard({ enabled }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState('');
  const { data, error } = useQuery({ queryKey: ['panelMcp'], queryFn: api.panelMcp, enabled, staleTime: 30_000 });

  const act = async (what, fn) => {
    setBusy(what);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['panelMcp'] });
    } finally {
      setBusy('');
    }
  };

  if (error) return <div className="card p-5 text-sm text-danger">Could not read the MCP settings: {error.message}</div>;
  if (!data) return <div className="card p-5 text-sm text-muted">Loading…</div>;

  const url = `${window.location.origin}${data.path}${data.key ? `?key=${data.key}` : ''}`;
  const cli = `claude mcp add --transport http deploy "${url}"`;

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Icon.zap /> Deploy from Claude
          </h2>
          <p className="text-xs text-muted mt-1 leading-relaxed">
            This panel is also an MCP server. Give Claude the address below and it can deploy services, read build
            logs, restart processes and edit variables here — {data.tools} tools, nothing to install.
          </p>
        </div>
        {data.enabled && (
          <button
            onClick={() => act('revoke', api.panelMcpRevoke)}
            disabled={Boolean(busy)}
            className="btn-danger shrink-0 text-xs"
            title="The URL stops working immediately"
          >
            <Icon.trash /> Turn off
          </button>
        )}
      </div>

      {!data.enabled ? (
        <div className="mt-4">
          <button onClick={() => act('create', api.panelMcpCreate)} disabled={Boolean(busy)} className="btn-brand">
            <Icon.zap /> {busy === 'create' ? 'Generating…' : 'Generate the URL'}
          </button>
          <p className="text-[11px] text-muted mt-2">Off until you do. No key, no access.</p>
        </div>
      ) : (
        <>
          <div className="mt-4 space-y-3">
            <CopyField label="Claude Desktop — Settings → Connectors → Add custom connector" value={url} />
            <CopyField label="Claude Code — run this once" value={cli} />
          </div>

          <div className="mt-4 pt-3 border-t border-line flex items-start justify-between gap-4">
            <p className="text-xs text-warn leading-relaxed">
              The key in that URL acts with <span className="text-gray-200">owner rights</span>. Treat it like the
              panel password: paste it only into your own Claude, and turn it off here the moment a device with it
              goes missing.
            </p>
            <button
              onClick={() => act('rotate', api.panelMcpCreate)}
              disabled={Boolean(busy)}
              className="btn-ghost shrink-0 text-xs"
              title="Issue a new key; the old URL stops working"
            >
              <Icon.restart /> {busy === 'rotate' ? 'Rotating…' : 'New key'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------- repos to wire */

function RepoList({ repos }) {
  if (!repos.length) return null;

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-white">Repos to paste it into</h2>
      <p className="text-xs text-muted mt-1">
        Every GitHub repo this panel deploys from. Auto-deploy off means a push is received and then ignored.
      </p>

      <div className="mt-4 space-y-2">
        {repos.map((repo) => (
          <div
            key={repo.fullName}
            className="flex items-start justify-between gap-4 rounded-lg border border-line bg-bg-input/60 px-3 py-2.5"
          >
            <div className="min-w-0">
              <a
                href={repo.settingsUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[13px] text-gray-200 hover:text-white break-all"
                title="Open this repo's webhooks on GitHub"
              >
                {repo.fullName}
              </a>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
                {repo.panel && <span className="text-brand">the panel itself — auto-redeploy</span>}
                {repo.services.map((s, i) => (
                  <span key={i}>
                    {s.project} / <span className="text-gray-400">{s.name}</span>
                    {s.branch && <span className="font-mono"> @{s.branch}</span>}
                    {!s.autoDeploy && <span className="text-warn"> · auto-deploy off</span>}
                  </span>
                ))}
              </div>
            </div>
            <a
              href={repo.settingsUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-xs text-muted hover:text-white border border-line hover:border-gray-500 rounded-lg px-2.5 py-1.5 transition"
            >
              Webhooks ↗
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

