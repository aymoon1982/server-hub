import React, { useState, useEffect } from 'react';
import axios from 'axios';

function LineChart({ data, series, height = 150, yMax = 100, yUnit = '%', label }) {
  const W = 600;
  if (!data || data.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="muted">
        Collecting data — samples appear every 30 s…
      </div>
    );
  }

  const pad = { t: 8, r: 8, b: 24, l: 34 };
  const cW = W - pad.l - pad.r;
  const cH = height - pad.t - pad.b;

  const ts = data.map(d => d.t);
  const minT = ts[0], maxT = ts[ts.length - 1];
  const tRange = maxT - minT || 1;

  const xOf = t => pad.l + ((t - minT) / tRange) * cW;
  const yOf = v => pad.t + cH - Math.min(1, Math.max(0, v / yMax)) * cH;

  const makePath = key =>
    data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xOf(d.t).toFixed(1)},${yOf(d[key] || 0).toFixed(1)}`).join(' ');

  const numTL = 5;
  const timeLabels = Array.from({ length: numTL }, (_, i) => {
    const t = minT + (i / (numTL - 1)) * tRange;
    const d = new Date(t);
    const lbl = tRange > 86_400_000
      ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { x: xOf(t), lbl };
  });

  const yLines = yMax <= 100
    ? [0, 25, 50, 75, 100].filter(v => v <= yMax)
    : [0, Math.round(yMax / 4), Math.round(yMax / 2), Math.round(yMax * 3 / 4), Math.round(yMax)];

  const lastVals = data[data.length - 1];

  return (
    <div>
      {label && <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>{label}</div>}
      <svg viewBox={`0 0 ${W} ${height}`} style={{ width: '100%', height, display: 'block' }}>
        {yLines.map(v => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={yOf(v)} y2={yOf(v)}
              stroke="var(--line)" strokeWidth={0.5} strokeDasharray={v === 0 ? '0' : '3,5'} />
            <text x={pad.l - 3} y={yOf(v)} textAnchor="end" dominantBaseline="middle"
              fontSize={9} fill="var(--text-3)">{v}{yUnit}</text>
          </g>
        ))}
        {timeLabels.map((tl, i) => (
          <text key={i} x={tl.x} y={height - 2} textAnchor="middle" fontSize={9} fill="var(--text-3)">{tl.lbl}</text>
        ))}
        {series.map(s => (
          <path key={s.key} d={makePath(s.key)} fill="none" stroke={s.color}
            strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6 }}>
        {series.map(s => {
          const val = lastVals?.[s.key] ?? 0;
          return (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ width: 12, height: 3, background: s.color, borderRadius: 2, display: 'inline-block' }} />
              <span style={{ color: 'var(--text-2)' }}>{s.label}</span>
              <span className="mono" style={{ color: s.color }}>{val.toFixed(1)}{yUnit}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RANGES = ['1h', '6h', '24h', '7d'];

export function MetricsTab() {
  const [range, setRange] = useState('1h');
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = (r) => {
    setLoading(true);
    axios.get('/api/metrics/history', { params: { range: r } })
      .then(res => { setData(res.data.samples || []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(range); }, [range]);

  useEffect(() => {
    const t = setInterval(() => {
      axios.get('/api/metrics/history', { params: { range } })
        .then(res => setData(res.data.samples || []))
        .catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, [range]);

  const netPeak = Math.max(...data.map(d => Math.max(d.rx || 0, d.tx || 0)), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {RANGES.map(r => (
          <button key={r} className={`tab-pill ${range === r ? 'is-active' : ''}`} onClick={() => setRange(r)}>{r}</button>
        ))}
        <span className="muted mono" style={{ marginLeft: 8, fontSize: 11 }}>
          {data.length} sample{data.length !== 1 ? 's' : ''}
        </span>
        {loading && <span className="spinner" style={{ marginLeft: 4 }} />}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <LineChart
          data={data}
          series={[
            { key: 'cpu', label: 'CPU',  color: 'var(--accent)' },
            { key: 'ram', label: 'RAM',  color: '#f08a8a' },
            { key: 'gpu', label: 'GPU',  color: '#f0c75a' },
          ]}
          height={170}
          yMax={100}
          yUnit="%"
          label="CPU · RAM · GPU"
        />
      </div>

      <div className="card" style={{ padding: 16 }}>
        <LineChart
          data={data}
          series={[
            { key: 'rx', label: 'Receive',  color: '#6dd49a' },
            { key: 'tx', label: 'Transmit', color: '#f08a8a' },
          ]}
          height={130}
          yMax={netPeak * 1.25}
          yUnit=" Mbps"
          label="Network — Rx · Tx"
        />
      </div>
    </div>
  );
}
