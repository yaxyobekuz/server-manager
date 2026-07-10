// Minimal inline SVG icon set (stroke-based, Railway-ish).
const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };

export const Icon = {
  logo: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" {...p}>
      <path {...s} d="M3 12h18M12 3v18" />
      <circle cx="12" cy="12" r="9" {...s} />
    </svg>
  ),
  grid: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" {...s} />
      <rect x="14" y="3" width="7" height="7" rx="1.5" {...s} />
      <rect x="3" y="14" width="7" height="7" rx="1.5" {...s} />
      <rect x="14" y="14" width="7" height="7" rx="1.5" {...s} />
    </svg>
  ),
  cpu: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <rect x="6" y="6" width="12" height="12" rx="2" {...s} />
      <path {...s} d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </svg>
  ),
  chart: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <path {...s} d="M3 3v18h18" />
      <path {...s} d="M6 15l4-5 3.5 3L18 7" />
    </svg>
  ),
  box: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <path {...s} d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8" />
    </svg>
  ),
  github: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <path fill="currentColor" d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.7c-2.78.62-3.37-1.36-3.37-1.36-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9l-.01 2.81c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  ),
  rocket: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <path {...s} d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
    </svg>
  ),
  settings: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <circle cx="12" cy="12" r="3" {...s} />
      <path {...s} d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  vars: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <path {...s} d="M4 7V4h16v3M9 20h6M12 4v16" />
    </svg>
  ),
  list: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <path {...s} d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  ),
  globe: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <circle cx="12" cy="12" r="9" {...s} />
      <path {...s} d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
    </svg>
  ),
  plus: (p) => (
    <svg viewBox="0 0 24 24" width="16" height="16" {...p}>
      <path {...s} d="M12 5v14M5 12h14" />
    </svg>
  ),
  restart: (p) => (
    <svg viewBox="0 0 24 24" width="15" height="15" {...p}>
      <path {...s} d="M23 4v6h-6M1 20v-6h6" />
      <path {...s} d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  ),
  stop: (p) => (
    <svg viewBox="0 0 24 24" width="13" height="13" {...p}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  ),
  play: (p) => (
    <svg viewBox="0 0 24 24" width="13" height="13" {...p}>
      <path fill="currentColor" d="M6 4l14 8-14 8z" />
    </svg>
  ),
  trash: (p) => (
    <svg viewBox="0 0 24 24" width="15" height="15" {...p}>
      <path {...s} d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    </svg>
  ),
  chevron: (p) => (
    <svg viewBox="0 0 24 24" width="16" height="16" {...p}>
      <path {...s} d="M9 18l6-6-6-6" />
    </svg>
  ),
  back: (p) => (
    <svg viewBox="0 0 24 24" width="16" height="16" {...p}>
      <path {...s} d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  ),
  logout: (p) => (
    <svg viewBox="0 0 24 24" width="16" height="16" {...p}>
      <path {...s} d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  ),
  check: (p) => (
    <svg viewBox="0 0 24 24" width="15" height="15" {...p}>
      <path {...s} d="M20 6L9 17l-5-5" />
    </svg>
  ),
  terminal: (p) => (
    <svg viewBox="0 0 24 24" width="18" height="18" {...p}>
      <rect x="2" y="4" width="20" height="16" rx="2" {...s} />
      <path {...s} d="M6.5 9.5l3.5 2.5-3.5 2.5M12.5 15h5" />
    </svg>
  ),
  search: (p) => (
    <svg viewBox="0 0 24 24" width="15" height="15" {...p}>
      <circle cx="11" cy="11" r="7" {...s} />
      <path {...s} d="M21 21l-4.35-4.35" />
    </svg>
  ),
  dots: (p) => (
    <svg viewBox="0 0 24 24" width="16" height="16" {...p}>
      <circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  ),
  copy: (p) => (
    <svg viewBox="0 0 24 24" width="15" height="15" {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2" {...s} />
      <path {...s} d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
};

export function StatusDot({ className = '', pulse = false }) {
  return (
    <span className="relative flex h-2 w-2">
      {pulse && <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${className}`} />}
      <span className={`relative inline-flex rounded-full h-2 w-2 ${className}`} />
    </span>
  );
}
