import { useState } from 'react';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import Toggle from './Toggle.jsx';

/**
 * Link another server running this panel — or fix the details of one.
 *
 * Authentication is deliberately the same thing a human types: that
 * server's admin password. It is verified here and then stored encrypted,
 * so it is asked exactly once per server.
 */
export default function ServerForm({ existing, onSaved, onCancel }) {
  const [name, setName] = useState(existing?.name || '');
  const [url, setUrl] = useState(existing?.url || '');
  const [password, setPassword] = useState('');
  const [insecure, setInsecure] = useState(Boolean(existing?.insecure));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const payload = { name: name.trim(), url: url.trim(), insecure, ...(password ? { password } : {}) };
      const { server } = existing
        ? await api.updateTransferServer(existing.id, payload)
        : await api.addTransferServer(payload);
      onSaved?.(server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="block text-sm text-gray-400 mb-2">Panel address</label>
        <input
          autoFocus={!existing}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="input font-mono text-[13px]"
          placeholder="deploy.my-other-server.com"
        />
        <p className="text-xs text-muted mt-1.5">
          Where that server's panel answers. Plain <span className="font-mono">host.com</span> means https; add
          <span className="font-mono"> :4500</span> or <span className="font-mono">http://</span> if it runs differently.
        </p>
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-2">
          That server's admin password {existing && <span className="text-muted">(leave empty to keep the saved one)</span>}
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
          placeholder={existing ? '••••••••' : 'the password you log into that panel with'}
          autoComplete="new-password"
        />
        <p className="text-xs text-muted mt-1.5">
          Asked once. It is stored encrypted on this server and replayed for you on every later transfer.
        </p>
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-2">Name <span className="text-muted">(optional)</span></label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input"
          placeholder="its hostname is used when you leave this empty"
        />
      </div>

      <label className="flex items-start gap-3 cursor-pointer" onClick={() => setInsecure(!insecure)}>
        <Toggle on={insecure} onChange={() => {}} />
        <span className="text-sm text-gray-300">
          Accept a self-signed certificate
          <span className="block text-xs text-muted">Only needed when that panel's HTTPS certificate is not from a public authority.</span>
        </span>
      </label>

      {error && <p className="text-sm text-danger whitespace-pre-wrap">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy} className="btn-ghost">
            Cancel
          </button>
        )}
        <button type="submit" disabled={busy || !url.trim() || (!existing && !password)} className="btn-brand">
          <Icon.check /> {busy ? 'Checking…' : existing ? 'Save' : 'Link this server'}
        </button>
      </div>
    </form>
  );
}
