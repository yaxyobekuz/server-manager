import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy /api and /ws to the Express server so the React app and the
// backend feel like one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1', // bind IPv4 so http://127.0.0.1:5173 works (not only [::1])
    proxy: {
      '/api': 'http://127.0.0.1:4500',
      '/ws': { target: 'ws://127.0.0.1:4500', ws: true },
    },
  },
});
