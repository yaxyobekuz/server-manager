import { useRef, useState } from 'react';

/**
 * Hand-rolled SVG time-series chart: y-axis gridlines with labels, x-axis
 * time labels, multi-series areas/lines, and a hover crosshair with an exact
 * tooltip. No chart lib — keeps the bundle tiny and the style on-theme.
 *
 * series: [{ name, color, dash?, points: [{ t, v }] }]
 */
const W = 800;
const H = 190;
const PADL = 56;
const PADR = 10;
const PADT = 10;
const PADB = 22;
const PLOT_W = W - PADL - PADR;
const PLOT_H = H - PADT - PADB;

export default function Chart({ series, max, formatY = (v) => String(v), formatT = defaultT, height = 'h-44' }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null); // point index

  const n = Math.max(0, ...series.map((s) => s.points.length));
  if (!n) {
    return <div className={`${height} flex items-center justify-center text-xs text-muted`}>no data yet</div>;
  }

  const allV = series.flatMap((s) => s.points.map((p) => p.v));
  const ceil = max ?? Math.max(...allV, 1) * 1.08;
  const xAt = (i) => PADL + (n === 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W);
  const yAt = (v) => PADT + PLOT_H - (Math.min(v, ceil) / ceil) * PLOT_H;

  // Timeline (longest series drives the x axis).
  const timeline = series.reduce((a, s) => (s.points.length === n ? s.points : a), series[0].points);

  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PADL) / PLOT_W) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const gridFracs = [0.25, 0.5, 0.75, 1];
  const hoverX = hover !== null ? xAt(hover) : 0;
  const hoverLeftPct = (hoverX / W) * 100;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={`w-full ${height}`}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* y grid + labels */}
        <line x1={PADL} y1={PADT + PLOT_H} x2={W - PADR} y2={PADT + PLOT_H} stroke="#26262e" strokeWidth="1" />
        {gridFracs.map((f) => (
          <g key={f}>
            <line x1={PADL} y1={yAt(ceil * f)} x2={W - PADR} y2={yAt(ceil * f)} stroke="#26262e" strokeWidth="1" strokeDasharray="3 5" />
            <text x={PADL - 6} y={yAt(ceil * f) + 3} textAnchor="end" fontSize="10" fill="#6b6b76">
              {formatY(ceil * f)}
            </text>
          </g>
        ))}
        <text x={PADL - 6} y={PADT + PLOT_H + 3} textAnchor="end" fontSize="10" fill="#6b6b76">
          {formatY(0)}
        </text>

        {/* x labels: first / middle / last */}
        {[0, Math.floor((n - 1) / 2), n - 1]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((i) => (
            <text
              key={i}
              x={xAt(i)}
              y={H - 6}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              fontSize="10"
              fill="#6b6b76"
            >
              {formatT(timeline[i]?.t)}
            </text>
          ))}

        {/* series */}
        {series.map(({ points, color, dash }, si) => {
          if (!points.length) return null;
          const pts = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.v).toFixed(1)}`).join(' ');
          return (
            <g key={si}>
              {!dash && (
                <polyline
                  points={`${PADL},${PADT + PLOT_H} ${pts} ${xAt(points.length - 1)},${PADT + PLOT_H}`}
                  fill={color}
                  opacity="0.09"
                  stroke="none"
                />
              )}
              <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeDasharray={dash ? '5 4' : undefined} />
            </g>
          );
        })}

        {/* crosshair + dots */}
        {hover !== null && (
          <g>
            <line x1={hoverX} y1={PADT} x2={hoverX} y2={PADT + PLOT_H} stroke="#4b4b56" strokeWidth="1" />
            {series.map(({ points, color }, si) =>
              points[hover] !== undefined ? (
                <circle key={si} cx={hoverX} cy={yAt(points[hover].v)} r="3.5" fill={color} stroke="#0e0e12" strokeWidth="1.5" />
              ) : null
            )}
          </g>
        )}
      </svg>

      {/* tooltip */}
      {hover !== null && timeline[hover] && (
        <div
          className="absolute top-1 z-10 pointer-events-none bg-bg-input border border-line rounded-lg px-3 py-2 shadow-xl min-w-[130px]"
          style={hoverLeftPct > 65 ? { right: `${100 - hoverLeftPct + 2}%` } : { left: `${hoverLeftPct + 2}%` }}
        >
          <div className="text-[10px] text-muted mb-1">{formatT(timeline[hover].t, true)}</div>
          {series.map(({ name, color, points }, si) =>
            points[hover] !== undefined ? (
              <div key={si} className="flex items-center justify-between gap-3 text-[11px] leading-5">
                <span className="flex items-center gap-1.5 text-gray-300">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  {name}
                </span>
                <span className="text-white font-mono">{formatY(points[hover].v)}</span>
              </div>
            ) : null
          )}
        </div>
      )}
    </div>
  );
}

function defaultT(t, long) {
  if (!t) return '';
  const d = new Date(t);
  return long ? d.toLocaleString() : d.toLocaleTimeString();
}
