import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { Icon } from '../Icons.jsx';

/** Railway-style env var editor: key/value rows + a raw .env paste mode. */
export default function VariablesTab({ serviceId }) {
  const [rows, setRows] = useState([]);
  const [raw, setRaw] = useState('');
  const [mode, setMode] = useState('table'); // table | raw
  const [saved, setSaved] = useState(false);

  const fromObj = (obj) => Object.entries(obj).map(([k, v]) => ({ k, v }));
  const toObj = (rs) => Object.fromEntries(rs.filter((r) => r.k).map((r) => [r.k, r.v]));

  const load = () =>
    api.variables(serviceId).then((d) => {
      const r = fromObj(d.variables || {});
      setRows(r.length ? r : [{ k: '', v: '' }]);
      setRaw(r.map((x) => `${x.k}=${x.v}`).join('\n'));
    });
  useEffect(() => { load(); }, [serviceId]);

  const parseRaw = (text) =>
    Object.fromEntries(
      text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    );

  const save = async () => {
    const variables = mode === 'raw' ? parseRaw(raw) : toObj(rows);
    await api.saveVariables(serviceId, variables);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    if (mode === 'raw') setRows(fromObj(variables).length ? fromObj(variables) : [{ k: '', v: '' }]);
  };

  return (
    <div className="card p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-white font-semibold">Variables</h3>
          <p className="text-xs text-muted mt-0.5">Written to <span className="font-mono">.env</span> on every deploy.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-bg-input border border-line rounded-lg p-0.5 text-xs">
            <button onClick={() => setMode('table')} className={`px-2.5 py-1 rounded ${mode === 'table' ? 'bg-bg-hover text-white' : 'text-muted'}`}>Table</button>
            <button onClick={() => { setRaw(rows.filter((r) => r.k).map((r) => `${r.k}=${r.v}`).join('\n')); setMode('raw'); }} className={`px-2.5 py-1 rounded ${mode === 'raw' ? 'bg-bg-hover text-white' : 'text-muted'}`}>Raw</button>
          </div>
          <button onClick={save} className="btn-brand">{saved ? <><Icon.check /> Saved</> : 'Save'}</button>
        </div>
      </div>

      {mode === 'table' ? (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={row.k}
                onChange={(e) => setRows(rows.map((r, j) => j === i ? { ...r, k: e.target.value } : r))}
                placeholder="KEY"
                className="input font-mono text-xs w-1/3"
              />
              <input
                value={row.v}
                onChange={(e) => setRows(rows.map((r, j) => j === i ? { ...r, v: e.target.value } : r))}
                placeholder="value"
                className="input font-mono text-xs flex-1"
              />
              <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="btn-ghost px-2 text-muted hover:text-danger"><Icon.trash /></button>
            </div>
          ))}
          <button onClick={() => setRows([...rows, { k: '', v: '' }])} className="text-xs text-brand hover:underline flex items-center gap-1 mt-2"><Icon.plus width={13} height={13} /> Add variable</button>
        </div>
      ) : (
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          spellCheck={false}
          className="input font-mono text-xs h-64 resize-none"
          placeholder="KEY=value&#10;ANOTHER=value"
        />
      )}
    </div>
  );
}
