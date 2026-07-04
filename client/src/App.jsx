import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { getToken, clearToken } from './api/client.js';
import Login from './pages/Login.jsx';
import Shell from './components/Shell.jsx';
import Projects from './pages/Projects.jsx';
import ProjectCanvas from './pages/ProjectCanvas.jsx';
import ServiceDetail from './pages/ServiceDetail.jsx';
import Processes from './pages/Processes.jsx';
import Statistics from './pages/Statistics.jsx';

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  return (
    <Shell onLogout={() => { clearToken(); setAuthed(false); }}>
      <Routes>
        <Route path="/" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectCanvas />} />
        <Route path="/projects/:id/services/:serviceId" element={<ServiceDetail />} />
        <Route path="/statistics" element={<Statistics />} />
        <Route path="/processes" element={<Processes />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
