import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
 * MCP access: the panel's address plus the panel's password, and that is the
 * whole setup. The password is not in the page until the owner asks for it —
 * one click, so the URL can be copied ready to paste, without it sitting on
 * screen for anyone who walks past.
 */
function McpCard({ enabled }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { data, error } = useQuery({ queryKey: ['panelMcp'], queryFn: api.panelMcp, enabled, staleTime: Infinity });

  const reveal = async () => {
    setLoading(true);
    try {
      const r = await api.panelMcpPassword();
      setPassword(r.password || '');
    } finally {
      setLoading(false);
    }
  };

  if (error) return <div className="card p-5 text-sm text-danger">Could not load the MCP details: {error.message}</div>;
  if (!data) return <div className="card p-5 text-sm text-muted">Loading…</div>;

  const shown = password || 'YOUR-PANEL-PASSWORD';
  const plain = `${window.location.origin}${data.path}`;
  const url = `${plain}?password=${encodeURIComponent(shown)}`;

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-white flex items-center gap-2">
        <Icon.zap /> Deploy from Claude
      </h2>
      <p className="text-xs text-muted mt-1 leading-relaxed">
        This panel is also an MCP server, so Claude on your own computer can deploy services, read build logs, restart
        processes and edit variables here — {data.tools} tools, nothing to install. It takes this address and the
        password you log in with; there is no second secret to manage.
      </p>

      {!data.ready && (
        <p className="text-xs text-danger mt-3">
          <code className="font-mono">ADMIN_PASSWORD</code> is not set in <code className="font-mono">server/.env</code>
          , so there is nothing to log in with yet.
        </p>
      )}

      <div className="mt-4 space-y-3">
        <CopyField label="Claude Desktop — Settings → Connectors → Add custom connector" value={url} />
        {/* The CLI can send a header, which keeps the password out of the URL
            — and therefore out of every log between here and there. */}
        <CopyField
          label="Claude Code — run this once"
          value={`claude mcp add --transport http deploy ${plain} --header "Authorization: Bearer ${shown}"`}
        />
      </div>

      {!password ? (
        <button onClick={reveal} disabled={loading} className="btn-ghost text-xs mt-3">
          <Icon.vars /> {loading ? 'One moment…' : 'Fill in my password'}
        </button>
      ) : (
        <p className="text-xs text-warn mt-3 leading-relaxed">
          Those now carry your panel password — it is the whole login, so paste them only into your own Claude. To cut
          off anything that holds it, change <code className="font-mono">ADMIN_PASSWORD</code> in{' '}
          <code className="font-mono">server/.env</code> and restart the panel. The Claude Code form sends it as a
          header instead of in the URL, which is the safer of the two where you have the choice.
        </p>
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

