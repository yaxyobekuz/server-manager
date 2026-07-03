import { useState } from 'react';
import { api, setToken } from '../api/client.js';
import { Icon } from '../components/Icons.jsx';
import logo from '../assets/logo.svg';

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token } = await api.login(password);
      setToken(token);
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-4 bg-grid-fade">
      <form onSubmit={submit} className="w-full max-w-sm card p-8">
        <div className="flex items-center gap-3 mb-1">
          <img src={logo} alt="Deploy logo" className="w-10 h-10 rounded-xl shadow-glow" />
          <div>
            <h1 className="text-lg font-semibold text-white">Deploy</h1>
            <p className="text-xs text-muted">VPS deployment manager</p>
          </div>
        </div>

        <label className="block text-sm text-gray-400 mt-7 mb-2">Admin password</label>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
          placeholder="••••••••"
        />
        {error && <p className="text-danger text-sm mt-3">{error}</p>}
        <button type="submit" disabled={loading} className="btn-brand w-full mt-5">
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
