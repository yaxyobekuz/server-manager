import { useState } from 'react';
import { Icon } from './Icons.jsx';

/**
 * Admin-editable creation date with a visible change history.
 * `entity` carries { createdAt, createdAtHistory }; `onSave(iso)` persists
 * and must resolve with the updated entity applied by the parent.
 */
const toLocal = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmt = (iso) =>
  iso
    ? new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

export default function CreatedAtEditor({ entity, onSave }) {
  const [value, setValue] = useState(toLocal(entity.createdAt));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const history = [...(entity.createdAtHistory || [])].reverse();

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await onSave(new Date(value).toISOString());
      setMsg({ ok: true, text: 'Saved — recorded in history.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 2500);
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="datetime-local"
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button onClick={save} disabled={busy || !value} className="btn-ghost shrink-0">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {msg && <p className={`text-xs mt-2 ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</p>}

      {history.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] text-muted uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <Icon.list width={12} height={12} /> Change history
          </div>
          <div className="space-y-1.5">
            {history.map((h, i) => (
              <div key={i} className="text-xs bg-bg-input border border-line rounded-lg px-3 py-2">
                <span className="text-gray-300 font-mono">
                  {h.from ? `${fmt(h.from)} → ` : ''}{fmt(h.to)}
                </span>
                <span className="text-muted ml-2">
                  changed {fmt(h.at)}{h.note ? ` · ${h.note}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
