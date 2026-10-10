import { useState } from 'react';

interface Series {
  name: string;
  color: string;
}
interface Datum {
  label: string;
  values: number[];
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Column chart (stacked when >1 series). Thin bars, 4px rounded data-end, 2px surface gap between segments, hover tooltip, table fallback. */
export function BarChart({
  data,
  series,
  format,
  title,
}: {
  data: Datum[];
  series: Series[];
  format: (n: number) => string;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 640;
  const H = 220;
  const pad = { l: 56, r: 8, t: 10, b: 26 };
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(0, ...totals));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const band = iw / Math.max(1, data.length);
  const bw = Math.min(24, band * 0.6);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / 8);

  return (
    <div className="chart stack-sm">
      <div className="spread">
        {series.length > 1 ? (
          <div className="legend" aria-hidden="true">
            {series.map((s) => (
              <span key={s.name}>
                <i style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </div>
        ) : (
          <span />
        )}
        <button className="btn sm ghost" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {table ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th>Date</th>
                {series.map((s) => (
                  <th key={s.name} className="num">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  {d.values.map((v, i) => (
                    <td key={i} className="num">
                      {format(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${title}. Use “Show table” for values.`}
            onMouseLeave={() => setHover(null)}
          >
            <g className="axis">
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
                  <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">
                    {format(t)}
                  </text>
                </g>
              ))}
              {data.map((d, i) =>
                i % labelEvery === 0 ? (
                  <text key={d.label} x={pad.l + band * i + band / 2} y={H - 8} textAnchor="middle">
                    {d.label}
                  </text>
                ) : null,
              )}
            </g>
            {data.map((d, i) => {
              const x = pad.l + band * i + (band - bw) / 2;
              let acc = 0;
              const segs = d.values.map((v, si) => {
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                return { si, v, top: y1, h: Math.max(0, y0 - y1) };
              });
              const visible = segs.filter((s) => s.h > 0);
              const topIdx = visible.length ? visible[visible.length - 1].si : -1;
              return (
                <g
                  key={d.label}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  tabIndex={0}
                  aria-label={`${d.label}: ${series.map((s, si) => `${s.name} ${format(d.values[si])}`).join(', ')}`}
                >
                  <rect x={pad.l + band * i} y={pad.t} width={band} height={ih} fill="transparent" />
                  {visible.map((s) => {
                    const gap = s.si === topIdx ? 0 : 2; // 2px surface gap between stacked segments
                    const h = Math.max(0, s.h - gap);
                    const r = s.si === topIdx ? Math.min(4, h / 2, bw / 2) : 0;
                    const top = s.top + gap;
                    return r > 0 ? (
                      <path
                        key={s.si}
                        fill={series[s.si].color}
                        opacity={hover === null || hover === i ? 1 : 0.55}
                        d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + h} Z`}
                      />
                    ) : (
                      <rect
                        key={s.si}
                        x={x}
                        y={top}
                        width={bw}
                        height={h}
                        fill={series[s.si].color}
                        opacity={hover === null || hover === i ? 1 : 0.55}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
          {hover !== null && data[hover] && (
            <div
              className="chart-tip"
              style={{
                left: `${((pad.l + band * hover + band / 2) / W) * 100}%`,
                top: `${(y(totals[hover]) / H) * 100}%`,
              }}
            >
              <strong>{data[hover].label}</strong>
              {series.map((s, si) => (
                <div key={s.name}>
                  {series.length > 1 && `${s.name}: `}
                  {format(data[hover].values[si])}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
