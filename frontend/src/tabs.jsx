import React, { useState, useMemo, useEffect, useRef } from 'react';
import axios from 'axios';
import { ShareEditor, ShareBrowser, SSHKeysPanel, FormField, SystemUpdatesTab } from './features.jsx';
import { Modal } from './ui-bridge.jsx';
import Editor from '@monaco-editor/react';

export const makeDynamicUrl = (originalUrl) => {
  if (!originalUrl) return originalUrl;
  try {
    const urlObj = new URL(originalUrl);
    urlObj.hostname = window.location.hostname;
    return urlObj.toString();
  } catch (e) {
    return originalUrl;
  }
};

// ---------- atoms ----------
function Sparkline({ data, width = 80, height = 22, stroke = 'currentColor', fill = 'none' }) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = width / (data.length - 1 || 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(2)},${(height - ((v - min) / range) * height).toFixed(2)}`).join(' ');
  const area = `0,${height} ${pts} ${width},${height}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', overflow: 'visible' }}>
      {fill !== 'none' && <polygon points={area} fill={fill} opacity={0.18} />}
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Gauge({ value, label, sub, max = 100, size = 88 }) {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const off = c - (value / max) * c;
  return (
    <div className="gauge">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} stroke="var(--line)" strokeWidth={6} fill="none" />
        <circle cx={size/2} cy={size/2} r={r} stroke="var(--accent)" strokeWidth={6} fill="none"
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`} style={{ transition: 'stroke-dashoffset .6s ease' }} />
      </svg>
      <div className="gauge-text">
        <div className="gauge-val mono">{value.toFixed(0)}<span>%</span></div>
        <div className="gauge-lbl">{label}</div>
        {sub && <div className="gauge-sub mono">{sub}</div>}
      </div>
    </div>
  );
}

function Bar({ value, max = 100, tone }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="bar">
      <div className="bar-fill" style={{ width: pct + '%', background: tone || 'var(--accent)' }} />
    </div>
  );
}

function StatusDot({ status }) {
  const map = {
    running: 'ok',
    connected: 'ok',
    stopped: 'err',
    idle: 'mute',
    warn: 'warn',
    closed: 'mute',
  };
  return <span className={`dot dot-${map[status] || 'mute'}`} />;
}

function Chip({ children, tone, onClick, active }) {
  return (
    <button type="button" className={`chip ${tone || ''} ${active ? 'is-active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

function Favicon({ ch, tag }) {
  const tags = { media: 285, 'smart-home': 145, storage: 220, monitoring: 30, arr: 320, devops: 200, security: 0, network: 180, database: 250, cache: 12, queue: 60, system: 220 };
  const hue = tags[tag] ?? 270;
  return (
    <div className="favicon" style={{ background: `oklch(0.42 0.08 ${hue})`, color: `oklch(0.92 0.06 ${hue})` }}>
      {ch}
    </div>
  );
}

function KBD({ children }) { return <kbd className="kbd">{children}</kbd>; }

// ---------- OVERVIEW (merged with Resources) ----------
const DEFAULT_LAYOUT = [
  { id: 'host_info', label: 'Host Info', visible: true, width: 'half' },
  { id: 'events', label: 'System Events', visible: true, width: 'half' },
  { id: 'cpu', label: 'CPU Telemetry', visible: true, width: 'full' },
  { id: 'ram', label: 'Memory Telemetry', visible: true, width: 'third' },
  { id: 'disk', label: 'Storage & Disks', visible: true, width: 'third' },
  { id: 'net', label: 'Network throughput', visible: true, width: 'third' },
  { id: 'smart', label: 'SMART Diagnostics', visible: true, width: 'full' },
  { id: 'gpu', label: 'GPU Telemetry', visible: true, width: 'third' },
  { id: 'proc', label: 'Top Processes', visible: true, width: 'full' },
];

function Overview({ onNav }) {
  const [stats, setStats] = useState(null);
  const [services, setServices] = useState([]);
  const [shares, setShares] = useState([]);
  const [events, setEvents] = useState([]);
  const [smart, setSmart] = useState([]);
  const [customizing, setCustomizing] = useState(false);

  const [layout, setLayout] = useState(() => {
    const cached = localStorage.getItem('dashboard_overview_layout');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        const updated = DEFAULT_LAYOUT.map(d => {
          const match = parsed.find(p => p.id === d.id);
          return match ? { ...d, visible: match.visible } : d;
        });
        const orderMap = parsed.map(p => p.id);
        updated.sort((a, b) => orderMap.indexOf(a.id) - orderMap.indexOf(b.id));
        return updated;
      } catch (e) {}
    }
    return DEFAULT_LAYOUT;
  });

  const saveLayout = (newLayout) => {
    setLayout(newLayout);
    localStorage.setItem('dashboard_overview_layout', JSON.stringify(newLayout));
  };

  const moveWidget = (index, direction) => {
    const newLayout = [...layout];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newLayout.length) return;
    const temp = newLayout[index];
    newLayout[index] = newLayout[targetIndex];
    newLayout[targetIndex] = temp;
    saveLayout(newLayout);
  };

  const toggleWidget = (index) => {
    const newLayout = [...layout];
    newLayout[index] = { ...newLayout[index], visible: !newLayout[index].visible };
    saveLayout(newLayout);
  };

  const resetLayout = () => {
    saveLayout(DEFAULT_LAYOUT.map(w => ({ ...w })));
  };

  const [cpuHistory, setCpuHistory] = useState(() => Array.from({length: 24}, () => 10 + Math.floor(Math.random() * 20)));
  const [ramHistory, setRamHistory] = useState(() => Array.from({length: 24}, () => 20 + Math.floor(Math.random() * 10)));
  const [rxHistory, setRxHistory] = useState(() => Array.from({length: 24}, () => 0));
  const [txHistory, setTxHistory] = useState(() => Array.from({length: 24}, () => 0));

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await axios.get('/api/stats');
        if (!mountedRef.current) return;
        setStats(res.data);
        setCpuHistory(prev => [...prev.slice(1), res.data.cpu]);
        setRamHistory(prev => [...prev.slice(1), res.data.ram]);
        setRxHistory(prev => [...prev.slice(1), res.data.network?.rxMbps || 0]);
        setTxHistory(prev => [...prev.slice(1), res.data.network?.txMbps || 0]);
      } catch (e) {}
    };

    const fetchServices = async () => {
      try {
        const [servicesRes, sharesRes] = await Promise.all([
          axios.get('/api/services'),
          axios.get('/api/samba/shares'),
        ]);
        if (!mountedRef.current) return;
        setServices(servicesRes.data);
        setShares(sharesRes.data);
        const evts = [];
        const runningWeb = servicesRes.data.filter(s => s.isWebUi && s.isRunning).length;
        evts.push({ t: 'just now', kind: 'info', msg: `${runningWeb} web services online and accessible.` });
        if (sharesRes.data.length > 0) {
          evts.push({ t: '1m ago', kind: 'ok', msg: `Samba running with ${sharesRes.data.length} active shares.` });
        }
        const stopped = servicesRes.data.filter(s => !s.isRunning);
        if (stopped.length > 0) {
          evts.push({ t: '5m ago', kind: 'warn', msg: `${stopped.length} container(s) are currently offline.` });
        } else {
          evts.push({ t: '5m ago', kind: 'ok', msg: 'All backend containers running normally.' });
        }
        setEvents(evts);
      } catch (e) {}
    };

    axios.get('/api/disk/smart').then(r => { if (mountedRef.current) setSmart(r.data.disks || []); }).catch(() => {});

    fetchStats();
    fetchServices();
    const statsInterval = setInterval(fetchStats, 2000);
    const svcInterval = setInterval(fetchServices, 5000);
    return () => { clearInterval(statsInterval); clearInterval(svcInterval); };
  }, []);



  const diskStats = useMemo(() => {
    const list = stats?.disk || [];
    let totalUsed = 0, totalTotal = 0;
    list.forEach(d => { totalUsed += d.used; totalTotal += d.total; });
    const pct = totalTotal > 0 ? Math.round((totalUsed / totalTotal) * 100) : 0;
    return { used: totalUsed, total: totalTotal, free: totalTotal - totalUsed, pct };
  }, [stats]);

  const sshCount = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('dashboard_ssh_servers') || '[]').length; } catch { return 0; }
  }, []);

  if (!stats) return <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-3)' }}>Loading overview…</div>;

  const runningWeb = services.filter(s => s.isWebUi && s.isRunning).length;
  const runningBack = services.filter(s => !s.isWebUi && s.isRunning).length;
  const sambaActive = shares.length;
  const ramTotalG = stats.ramRaw?.total ? (stats.ramRaw.total / 1024).toFixed(1) : '—';
  const ramUsedG = stats.ramRaw?.used ? (stats.ramRaw.used / 1024).toFixed(1) : '—';
  const netIface = stats.network?.interface || 'eth0';
  const netType = stats.network?.type || 'Ethernet';
  const netCurrentSpeed = stats.network?.currentSpeed || 0;
  const netMaxSpeed = stats.network?.maxSpeed || 0;
  const netTypeColor = netType === 'Wi-Fi' ? { bg: 'oklch(0.28 0.06 200)', fg: 'oklch(0.78 0.12 200)' }
    : netType === 'Virtual' ? { bg: 'oklch(0.28 0.06 285)', fg: 'oklch(0.78 0.12 285)' }
    : { bg: 'oklch(0.28 0.06 150)', fg: 'oklch(0.78 0.14 150)' };

  const renderWidget = (id) => {
    switch (id) {
      case 'host_info':
        return (
          <div className="card bento-card" style={{ height: '100%', boxSizing: 'border-box' }}>
            <div className="card-head">
              <h3>Host info</h3>
              <span className="mono muted">{stats.host?.version || 'v1.0.0'}</span>
            </div>
            <div className="host-details-grid mono">
              <div><span>Hostname</span><b>{stats.host?.name || 'server'}</b></div>
              <div><span>OS Distro</span><b>{stats.host?.distro || 'Linux'}</b></div>
              <div><span>Kernel</span><b>{stats.host?.kernel || '—'}</b></div>
              <div><span>Uptime</span><b>{stats.host?.uptime || '—'}</b></div>
              <div><span>IP Address</span><b>{stats.host?.ip || '127.0.0.1'}</b></div>
              <div><span>Processor</span><b>{stats.host?.cpuModel || 'Generic'}</b></div>
              <div><span>Cores / RAM</span><b>{stats.host?.cores || 1} cores · {ramTotalG} GB</b></div>
              <div><span>CPU Usage</span><b>{stats.cpu?.toFixed(1)}% · {ramUsedG} GB mem</b></div>
            </div>
          </div>
        );
      case 'events':
        return (
          <div className="card bento-card" style={{ height: '100%', boxSizing: 'border-box' }}>
            <div className="card-head"><h3>System events</h3></div>
            <div className="event-list" style={{ overflowY: 'auto', maxHeight: 220 }}>
              {events.map((ev, i) => (
                <div key={i} className="event-row">
                  <span className={`event-dot dot-${ev.kind}`} />
                  <span className="event-time mono muted">{ev.t}</span>
                  <span className="event-msg">{ev.msg}</span>
                </div>
              ))}
              {events.length === 0 && <div className="empty muted">No recent events</div>}
            </div>
          </div>
        );
      case 'cpu':
        return (
          <div className="card res-cpu" style={{ height: '100%', boxSizing: 'border-box' }}>
            <div className="card-head">
              <h3>CPU</h3>
              <span className="muted mono" style={{ fontSize: '11px' }}>{stats.host?.cpuModel}</span>
            </div>
            <div className="res-big-row" style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
              <Gauge value={stats.cpu} label="utilization" sub={`temp ${stats.temps?.cpu ? stats.temps.cpu.toFixed(0) : 0}°C`} />
              <div className="res-big-spark" style={{ flex: 1, minWidth: 200 }}>
                <Sparkline data={cpuHistory} width={300} height={56} stroke="var(--accent)" fill="var(--accent)" />
                <div className="res-spark-meta mono">load avg <b>{stats.cpu?.toFixed(1)}%</b></div>
              </div>
            </div>
            <div className="core-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(40px, 1fr))', gap: 6, marginTop: 12 }}>
              {Array.from({ length: Math.min(stats.host?.cores || 4, 16) }).map((_, i) => {
                const v = Math.min(100, Math.max(0, Math.round(stats.cpu * (0.6 + Math.random() * 0.8))));
                return (
                  <div key={i} className="core-cell" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div className="core-bar" style={{ height: 40, width: 8, background: 'var(--line)', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
                      <div className="core-fill" style={{ height: v + '%', width: '100%', background: 'var(--accent)', position: 'absolute', bottom: 0 }} />
                    </div>
                    <div className="core-num mono" style={{ fontSize: 9, marginTop: 4, color: 'var(--text-3)' }}>{i}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      case 'ram':
        return (
          <div className="card res-ram" style={{ height: '100%', boxSizing: 'border-box' }}>
            <div className="card-head"><h3>Memory</h3><span className="muted mono">{ramTotalG} GB</span></div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, justifyContent: 'center', height: '100%' }}>
              <Gauge value={stats.ram} label="used" sub={`${ramUsedG} / ${ramTotalG} GB`} size={104} />
              <div style={{ width: '100%' }}>
                <Sparkline data={ramHistory} width={260} height={48} stroke="var(--accent)" fill="var(--accent)" />
              </div>
            </div>
          </div>
        );
      case 'disk':
        return (
          <div className="card res-disk" style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', boxSizing: 'border-box' }}>
            <div className="card-head"><h3>Storage</h3></div>
            <div className="storage-summary" style={{ display: 'flex', gap: '14px', alignItems: 'center', background: 'var(--surface-2)', padding: '12px 16px', borderRadius: '10px', border: '1px dashed var(--line)' }}>
              <span style={{ fontSize: '28px' }}>🖴</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifySelf: 'stretch', justifyContent: 'space-between', marginBottom: '6px', fontSize: '12px' }}>
                  <span style={{ fontWeight: '500' }}>Overall Capacity</span>
                  <span className="mono" style={{ fontWeight: 'bold' }}>{diskStats.used}G / {diskStats.total}G ({diskStats.pct}%)</span>
                </div>
                <div className="bar" style={{ height: '8px', borderRadius: '4px', overflow: 'hidden', background: 'var(--line)' }}>
                  <div className="bar-fill" style={{ width: `${diskStats.pct}%`, background: diskStats.pct > 85 ? 'var(--err)' : diskStats.pct > 70 ? 'var(--warn)' : 'var(--accent)', height: '100%', borderRadius: '4px' }} />
                </div>
                <div style={{ display: 'flex', gap: '12px', fontSize: '10px', color: 'var(--text-3)', marginTop: '4px' }} className="mono">
                  <span>Used: {diskStats.used} GB</span><span>Free: {diskStats.free} GB</span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto', flex: 1, maxHeight: '240px', paddingRight: '4px' }}>
              {(stats.disk || []).map(d => {
                const freeG = d.total - d.used;
                return (
                  <div key={d.mount} style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 'bold' }}>{d.mount}</span>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>{d.pct}%</span>
                    </div>
                    <div className="bar" style={{ height: '4px', background: 'var(--line)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div className="bar-fill" style={{ width: `${d.pct}%`, background: d.pct > 85 ? 'var(--err)' : d.pct > 70 ? 'var(--warn)' : 'var(--accent)', height: '100%' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      case 'net':
        return (
          <div className="card res-net" style={{ height: '100%', boxSizing: 'border-box' }}>
            <div className="card-head">
              <h3>Network</h3>
              <span className="muted mono" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: '700', textTransform: 'uppercase', background: netTypeColor.bg, color: netTypeColor.fg }}>{netType}</span>
                {netIface}
              </span>
            </div>
            <div className="net-rows" style={{ display: 'flex', flexDirection: 'column', gap: 12, justifyContent: 'center', height: '100%', minHeight: 180 }}>
              <div className="net-row" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="net-lbl" style={{ width: 32, fontSize: 11, color: 'var(--text-3)' }}>↓ rx</span>
                <span className="net-val mono" style={{ flex: 1, fontSize: 14 }}>{stats.network?.rxMbps?.toFixed(1) || 0} <small>Mb/s</small></span>
                <Sparkline data={rxHistory} width={100} height={24} stroke="var(--accent)" fill="var(--accent)" />
              </div>
              <div className="net-row" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="net-lbl" style={{ width: 32, fontSize: 11, color: 'var(--text-3)' }}>↑ tx</span>
                <span className="net-val mono" style={{ flex: 1, fontSize: 14 }}>{stats.network?.txMbps?.toFixed(1) || 0} <small>Mb/s</small></span>
                <Sparkline data={txHistory} width={100} height={24} stroke="oklch(0.72 0.12 150)" fill="oklch(0.72 0.12 150)" />
              </div>
            </div>
          </div>
        );
      case 'smart':
        return smart.length > 0 ? (
          <div className="card" style={{ width: '100%' }}>
            <div className="card-head"><h3>SMART Health</h3><span className="muted mono">drive diagnostics</span></div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              {smart.map(d => (
                <div key={d.device} style={{ flex: '1 1 200px', padding: '10px', background: 'var(--bg-2)', border: `1px solid ${d.health === 'PASSED' ? 'var(--ok)' : d.health === 'N/A' ? 'var(--line)' : 'var(--err)'}`, borderRadius: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '6px' }}>
                    <span style={{ fontSize: '16px' }}>💽</span>
                    <div>
                      <div style={{ fontWeight: 'bold', fontSize: '11px' }} className="mono">/dev/{d.device}</div>
                      <div style={{ fontSize: '9px', color: 'var(--text-3)' }} className="mono">{d.model?.slice(0, 20)}</div>
                    </div>
                    <span style={{ marginLeft: 'auto', padding: '1px 5px', borderRadius: '3px', fontSize: '9px', fontWeight: 700, background: d.health === 'PASSED' ? 'oklch(0.28 0.08 150)' : d.health === 'N/A' ? 'var(--surface-2)' : 'oklch(0.28 0.08 18)', color: d.health === 'PASSED' ? 'oklch(0.78 0.12 150)' : d.health === 'N/A' ? 'var(--text-3)' : 'oklch(0.78 0.1 18)' }}>
                      {d.health}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null;
      case 'gpu':
        return stats.gpu !== undefined && stats.gpu > 0 ? (
          <div className="card res-gpu" style={{ height: '100%', boxSizing: 'border-box' }}>
            <div className="card-head"><h3>GPU</h3><span className="muted mono">NVIDIA GPU</span></div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, justifyContent: 'center', height: '100%' }}>
              <Gauge value={stats.gpu || 0} label="util" sub={`temp ${stats.temps?.gpu?.toFixed(0) || 0}°C`} size={88} />
            </div>
          </div>
        ) : null;
      case 'proc':
        return (
          <div className="card res-proc" style={{ width: '100%' }}>
            <div className="card-head"><h3>Top processes</h3><span className="muted mono">by CPU + MEM</span></div>
            <table className="proc-table mono" style={{ width: '100%', fontSize: '11px' }}>
              <thead><tr><th>PID</th><th>Name</th><th>CPU</th><th>MEM</th></tr></thead>
              <tbody>
                {(stats.processes || []).slice(0, 6).map(p => (
                  <tr key={p.pid}>
                    <td>{p.pid}</td>
                    <td><b>{p.name}</b></td>
                    <td><span style={{ color: p.cpu > 50 ? 'var(--err)' : p.cpu > 20 ? 'var(--warn)' : 'var(--text)' }}>{(p.cpu ?? 0).toFixed(1)}%</span></td>
                    <td>{(p.mem ?? 0).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="tab-overview">
      <div className="bento">
        {/* KPI strip — service counts */}
        <div className="bento-row kpis">
          <KpiCard label="Web UIs" value={runningWeb.toString()} sub={`${services.filter(s => s.isWebUi).length} total discovered`} onClick={() => onNav('web')} colorClass="kpi-violet" />
          <KpiCard label="Backend" value={runningBack.toString()} sub={`${services.filter(s => !s.isWebUi).length} total services`} onClick={() => onNav('backend')} colorClass="kpi-cyan" />
          <KpiCard label="Samba" value={sambaActive.toString()} sub={`${shares.length} exported shares`} onClick={() => onNav('samba')} colorClass="kpi-green" />
          <KpiCard label="SSH Servers" value={sshCount.toString()} sub="saved connections" onClick={() => onNav('ssh')} colorClass="kpi-amber" />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button className="btn-ghost sm" onClick={() => setCustomizing(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            ⚙ Customize Layout
          </button>
        </div>

        {/* Bento / Resources Customizable Grid */}
        <div className="custom-bento-grid">
          {layout.filter(w => w.visible).map(w => {
            const content = renderWidget(w.id);
            if (!content) return null;

            let span = 6;
            if (w.width === 'half') span = 3;
            if (w.width === 'third') span = 2;

            return (
              <div key={w.id} style={{ gridColumn: `span ${span}`, minWidth: 260 }}>
                {content}
              </div>
            );
          })}
        </div>
      </div>

      {customizing && (
        <Modal title="Customize Dashboard Layout" onClose={() => setCustomizing(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p className="muted" style={{ fontSize: 12 }}>Toggle widget visibility and click the arrow keys to rearrange their layout order.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflowY: 'auto', paddingRight: 4 }}>
              {layout.map((w, index) => (
                <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 6 }}>
                  <input type="checkbox" checked={w.visible} onChange={() => toggleWidget(index)} id={`chk-${w.id}`} />
                  <label htmlFor={`chk-${w.id}`} style={{ flex: 1, fontSize: 12, cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }}>{w.label} <span className="muted" style={{ fontSize: 10, fontWeight: 'normal' }}>({w.width})</span></label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn-ghost sm" disabled={index === 0} onClick={() => moveWidget(index, -1)} style={{ padding: '2px 8px' }}>▲</button>
                    <button className="btn-ghost sm" disabled={index === layout.length - 1} onClick={() => moveWidget(index, 1)} style={{ padding: '2px 8px' }}>▼</button>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <button className="btn-ghost" onClick={resetLayout}>Reset to default</button>
              <button className="btn-accent" onClick={() => setCustomizing(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function KpiCard({ label, value, sub, onClick, colorClass = 'kpi-violet' }) {
  return (
    <button className={`kpi ${colorClass}`} onClick={onClick} style={{ textAlign: 'left' }}>
      <div className="kpi-lbl">{label}</div>
      <div className="kpi-val mono">{value}</div>
      {sub && <div className="kpi-sub mono">{sub}</div>}
    </button>
  );
}


// ---------- SERVICES ----------
function ServicesTab({ kind, cardStyle }) {
  const [services, setServices] = useState([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');

  const fetchServices = async () => {
    try {
      const res = await axios.get('/api/services');
      const mapped = (res.data || []).map(s => ({
        ...s,
        url: makeDynamicUrl(s.url)
      }));
      setServices(mapped);
    } catch (e) {}
  };

  useEffect(() => {
    fetchServices();
    const interval = setInterval(fetchServices, 4000);
    return () => clearInterval(interval);
  }, []);

  const rescan = () => {
    window.UI.toast({ kind: 'info', title: 'Scanning ports…' });
    fetchServices();
  };

  const addManual = () => {
    const name = prompt('Service name:');
    if (!name) return;
    const url = prompt('Service URL (e.g. http://localhost:8080):');
    if (!url) return;
    if (!/^https?:\/\//.test(url.trim())) {
      window.UI.toast({ kind: 'err', title: 'Invalid URL', body: 'Must start with http:// or https://' });
      return;
    }
    axios.post('/api/services/manual', { name, url })
      .then(() => {
        window.UI.toast({ kind: 'ok', title: 'Service added', body: name });
        fetchServices();
      })
      .catch(e => window.UI.toast({ kind: 'err', title: 'Failed to add', body: e.message }));
  };

  const restart = async (s) => {
    const ok = await window.UI.confirm({
      title: `Restart ${s.displayName || s.name}?`,
      body: s.type === 'docker' ? `Docker container "${s.containerName}" will be restarted.` : 'The backend service process will be restarted.',
      confirmLabel: 'Restart',
    });
    if (!ok) return;

    if (s.type === 'docker') {
      try {
        await axios.post('/api/docker/control', { name: s.containerName, action: 'restart' });
        window.UI.toast({ kind: 'ok', title: 'Restarted container', body: s.displayName });
        fetchServices();
      } catch (e) {
        window.UI.toast({ kind: 'err', title: 'Restart failed', body: e.message });
      }
    } else {
      window.UI.toast({ kind: 'warn', title: 'Unsupported', body: 'Process restart only supported on Docker containers' });
    }
  };

  const stop = async (s) => {
    const ok = await window.UI.confirm({
      title: `Stop ${s.displayName || s.name}?`,
      body: s.type === 'docker' ? `Docker container "${s.containerName}" will be stopped.` : 'The service process will be stopped.',
      confirmLabel: 'Stop',
      dangerous: true,
    });
    if (!ok) return;

    if (s.type === 'docker') {
      try {
        await axios.post('/api/docker/control', { name: s.containerName, action: 'stop' });
        window.UI.toast({ kind: 'ok', title: 'Stopped container', body: s.displayName });
        fetchServices();
      } catch (e) {
        window.UI.toast({ kind: 'err', title: 'Stop failed', body: e.message });
      }
    } else {
      window.UI.toast({ kind: 'warn', title: 'Unsupported', body: 'Process control only supported on Docker containers' });
    }
  };

  const open = (s) => {
    if (s.url) window.open(s.url, '_blank');
  };

  const onLogs = (s) => {
    if (s.type === 'docker') {
      window.SESS.launch({
        type: 'logs',
        title: `logs · ${s.name}`,
        glyph: '≣',
        data: { container: s.containerName }
      });
    } else {
      window.UI.toast({ kind: 'info', title: 'Logs unavailable', body: 'Service is not running in Docker.' });
    }
  };

  const isWeb = kind === 'web';
  const list = useMemo(() => {
    return services.filter(s => isWeb ? s.isWebUi : !s.isWebUi);
  }, [services, isWeb]);

  const filtered = useMemo(() => {
    let res = list;
    if (q) {
      res = res.filter(s => (s.displayName || s.name).toLowerCase().includes(q.toLowerCase()) || String(s.port).includes(q));
    }
    if (filter === 'running') {
      res = res.filter(s => s.isRunning);
    } else if (filter === 'stopped') {
      res = res.filter(s => !s.isRunning);
    }
    return res;
  }, [list, q, filter]);

  return (
    <div className="tab-services">
      <div className="services-toolbar">
        <div className="search">
          <span className="search-icon">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${isWeb ? 'web UIs' : 'backend services'}…`} />
        </div>
        <div className="filter-chips">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All <span className="mono">{list.length}</span></Chip>
          <Chip active={filter === 'running'} onClick={() => setFilter('running')}>Running</Chip>
          <Chip active={filter === 'stopped'} onClick={() => setFilter('stopped')}>Stopped</Chip>
        </div>
        <div className="toolbar-actions">
          <button className="btn-ghost" onClick={rescan}>↻ Rescan</button>
          <button className="btn-accent" onClick={addManual}>+ Add manual</button>
        </div>
      </div>

      {cardStyle === 'list' && <ServicesList list={filtered} kind={kind} onLogs={onLogs} onRestart={restart} onStop={stop} onOpen={open} />}
      {cardStyle === 'tile' && <ServicesTiles list={filtered} kind={kind} onLogs={onLogs} onRestart={restart} onOpen={open} />}
      {cardStyle === 'preview' && <ServicesPreview list={filtered} kind={kind} onLogs={onLogs} onOpen={open} />}
    </div>
  );
}

function ServicesTiles({ list, kind, onLogs, onRestart, onOpen }) {
  return (
    <div className="svc-tiles">
      {list.map(s => (
        <div key={s.name} className={`svc-tile ${!s.isRunning ? 'is-stopped' : ''}`}>
          <div className="svc-tile-top">
            {s.favicon ? <img src={s.favicon} alt="" className="favicon-img" style={{ width: '24px', height: '24px', borderRadius: '4px' }} onError={(e) => { e.target.style.display = 'none'; }} /> : <Favicon ch={(s.displayName || '?')[0].toUpperCase()} tag={s.type} />}
          </div>
          <div className="svc-tile-name" title={s.displayName}>{s.displayName}</div>
          <div className="svc-tile-meta mono">
            {s.port}
          </div>
          <div className="svc-tile-foot">
            <span className={`status-pill st-${s.isRunning ? 'running' : 'stopped'}`}>
              <StatusDot status={s.isRunning ? 'running' : 'stopped'} /> {s.isRunning ? 'running' : 'stopped'}
            </span>
            <span className="tag mono">{s.type}</span>
          </div>
          <div className="svc-tile-hover">
            {kind === 'web' && s.url && <button className="hov-btn primary" onClick={() => onOpen(s)}>Open ↗</button>}
            {s.type === 'docker' && <button className="hov-btn" onClick={() => onLogs(s)}>Logs</button>}
            {s.type === 'docker' && <button className="hov-btn" title="Restart" onClick={() => onRestart(s)}>↻</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ServicesList({ list, kind, onLogs, onRestart, onStop, onOpen }) {
  return (
    <div className="svc-list">
      <div className="svc-list-head mono">
        <span></span>
        <span>Service</span>
        <span>Address</span>
        <span>Container</span>
        <span>CPU</span>
        <span>RAM</span>
        <span>Status</span>
        <span></span>
      </div>
      {list.map(s => (
        <div key={s.name} className={`svc-row ${!s.isRunning ? 'is-stopped' : ''}`}>
          {s.favicon ? <img src={s.favicon} alt="" style={{ width: '18px', height: '18px', borderRadius: '3px' }} onError={(e) => { e.target.style.display = 'none'; }} /> : <Favicon ch={(s.displayName || '?')[0].toUpperCase()} tag={s.type} />}
          <div className="svc-row-name">
            <span>{s.displayName}</span>
            <span className="tag mono">{s.type}</span>
          </div>
          <div className="mono muted">{kind === 'web' ? s.url || `:${s.port}` : `:${s.port}`}</div>
          <div className="mono muted">{s.containerName || '—'}</div>
          <div className="mono">{s.usage?.cpu != null ? s.usage.cpu.toFixed(1) + '%' : '0.0%'}</div>
          <div className="mono">{s.usage?.mem != null ? (s.usage.mem / 1024 > 1 ? (s.usage.mem / 1024).toFixed(1) + 'G' : s.usage.mem.toFixed(0) + 'M') : '0M'}</div>
          <div><span className={`status-pill st-${s.isRunning ? 'running' : 'stopped'}`}><StatusDot status={s.isRunning ? 'running' : 'stopped'} /> {s.isRunning ? 'running' : 'stopped'}</span></div>
          <div className="svc-row-actions">
            {kind === 'web' && s.url && <button className="icon-btn" title="Open" onClick={() => onOpen(s)}>↗</button>}
            {s.type === 'docker' && <button className="icon-btn" title="Logs" onClick={() => onLogs(s)}>≣</button>}
            {s.type === 'docker' && <button className="icon-btn" title="Restart" onClick={() => onRestart(s)}>↻</button>}
            {s.type === 'docker' && <button className="icon-btn" title="Stop" onClick={() => onStop(s)}>■</button>}
          </div>
        </div>
      ))}
      {list.length === 0 && <div className="empty muted" style={{ padding: 32 }}>no services match</div>}
    </div>
  );
}

function ServicesPreview({ list, kind, onLogs, onOpen }) {
  return (
    <div className="svc-preview">
      {list.map(s => (
        <div key={s.name} className="svc-pcard">
          <div className="svc-pcard-thumb">
            <div className="pcard-stripes" />
            <div className="pcard-glyph">{(s.displayName || '?')[0].toUpperCase()}</div>
            <span className={`status-pill st-${s.isRunning ? 'running' : 'stopped'} pcard-status`}><StatusDot status={s.isRunning ? 'running' : 'stopped'} /> {s.isRunning ? 'running' : 'stopped'}</span>
          </div>
          <div className="svc-pcard-body">
            <div className="svc-pcard-name">{s.displayName}</div>
            <div className="svc-pcard-meta mono">{s.url || `:${s.port}`}</div>
            <div className="svc-pcard-actions">
              {kind === 'web' && s.url && <button className="btn-accent sm" onClick={() => onOpen(s)}>Open ↗</button>}
              {s.type === 'docker' && <button className="btn-ghost sm" onClick={() => onLogs(s)}>Logs</button>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- AGENTS ----------
function AgentsTab() {
  const [agents, setAgents] = useState([]);

  const loadAgents = async () => {
    try {
      const res = await axios.get('/api/agents');
      setAgents(res.data.agents || []);
    } catch (e) {}
  };

  useEffect(() => { loadAgents(); }, []);

  const rescan = () => {
    window.UI.toast({ kind: 'info', title: 'Scanning PATH for agents…' });
    loadAgents();
  };

  return (
    <div className="tab-agents">
      <div className="agents-intro">
        <div>
          <h2>AI coding agents</h2>
          <p className="muted">Detected CLI agents installed on this host. Launch any agent in a fullscreen session.</p>
        </div>
        <button className="btn-ghost" onClick={rescan}>↻ Rescan</button>
      </div>
      <div className="agent-grid">
        {agents.map(a => (
          <div key={a.id} className="agent-card">
            <div className="agent-glyph mono">{a.glyph || '✦'}</div>
            <div className="agent-body">
              <div className="agent-name">{a.label}</div>
              <div className="agent-meta mono">{a.vendor} · v{a.version}</div>
              <div className="agent-path mono muted" title={a.path}>{a.path}</div>
            </div>
            <button className="btn-accent" onClick={() => window.SESS.launch({
              type: 'agent',
              title: a.label,
              subtitle: `v${a.version}`,
              glyph: a.glyph || '✦',
              data: a,
            })}>Launch ▶</button>
          </div>
        ))}
        {agents.length === 0 && (
          <div style={{ padding: '24px', color: 'var(--text-3)' }}>No AI agents detected on this host.</div>
        )}
      </div>
    </div>
  );
}

// ---------- SAMBA ----------
function SambaTab() {
  const [sub, setSub] = useState('shares');
  const [status, setStatus] = useState({ smbd: 'stopped', nmbd: 'stopped' });

  const fetchStatus = async () => {
    try {
      const res = await axios.get('/api/samba/status');
      setStatus(res.data);
    } catch (e) {}
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 4000);
    return () => clearInterval(interval);
  }, []);

  const restartSvc = async (svc) => {
    const ok = await window.UI.confirm({
      title: `Restart ${svc}?`,
      body: 'Active SMB connections will be dropped briefly while the service restarts.',
      confirmLabel: 'Restart',
    });
    if (ok) {
      try {
        await axios.post('/api/samba/status', { action: 'restart' });
        window.UI.toast({ kind: 'ok', title: 'Samba restarted', body: 'Service is healthy.' });
        fetchStatus();
      } catch (e) {
        window.UI.toast({ kind: 'err', title: 'Restart failed', body: e.message });
      }
    }
  };

  const stopSvc = async (svc) => {
    const ok = await window.UI.confirm({
      title: `Stop ${svc}?`,
      body: 'All SMB shares will become unavailable until the service is started again.',
      confirmLabel: 'Stop service',
      dangerous: true,
    });
    if (ok) {
      try {
        await axios.post('/api/samba/status', { action: 'stop' });
        window.UI.toast({ kind: 'warn', title: 'Samba stopped', body: 'Shares are offline.' });
        fetchStatus();
      } catch (e) {
        window.UI.toast({ kind: 'err', title: 'Stop failed', body: e.message });
      }
    }
  };

  return (
    <div className="tab-samba">
      <div className="samba-head">
        <div className="samba-status">
          <div className="samba-svc">
            <span className={`dot dot-${status.smbd === 'running' ? 'ok' : 'err'}`} />
            <span><b>smbd</b> {status.smbd}</span>
          </div>
          <div className="samba-svc">
            <span className={`dot dot-${status.nmbd === 'running' ? 'ok' : 'err'}`} />
            <span><b>nmbd</b> {status.nmbd}</span>
          </div>
        </div>
        <div className="samba-actions">
          <button className="btn-ghost" onClick={() => restartSvc('smbd')}>Restart</button>
          <button className="btn-ghost" onClick={async () => {
            try {
              await axios.post('/api/samba/status', { action: 'reload' });
              window.UI.toast({ kind: 'ok', title: 'Reloaded', body: 'smb.conf re-read.' });
            } catch (e) {
              window.UI.toast({ kind: 'err', title: 'Reload failed', body: e.response?.data?.error || e.message });
            }
          }}>Reload</button>
          <button className="btn-ghost danger" onClick={() => stopSvc('smbd')}>Stop</button>
        </div>
      </div>
      <div className="subnav">
        {['shares', 'users', 'connections', 'settings', 'logs'].map(k => (
          <button key={k} className={`subnav-item ${sub === k ? 'is-active' : ''}`} onClick={() => setSub(k)}>{k}</button>
        ))}
      </div>
      {sub === 'shares' && <SambaShares />}
      {sub === 'users' && <SambaUsers />}
      {sub === 'connections' && <SambaConnections />}
      {sub === 'settings' && <SambaSettings />}
      {sub === 'logs' && <SambaLogs />}
    </div>
  );
}

function SambaShares() {
  const [shares, setShares] = useState([]);
  const [q, setQ] = useState('');

  const fetchShares = async () => {
    try {
      const res = await axios.get('/api/samba/shares');
      setShares(res.data.shares || res.data || []);
    } catch (e) {}
  };

  useEffect(() => { fetchShares(); }, []);

  const filtered = shares.filter(s => s.name.includes(q.toLowerCase()) || s.path.toLowerCase().includes(q.toLowerCase()));

  const newShare = () => {
    window.UI.modal(
      <ShareEditor
        onSave={() => fetchShares()}
        onClose={() => window.UI.closeModal()}
      />
    );
  };
  const editShare = (s) => {
    window.UI.modal(
      <ShareEditor
        share={s}
        onSave={() => fetchShares()}
        onClose={() => window.UI.closeModal()}
      />
    );
  };
  const browseShare = (s) => {
    window.UI.modal(
      <ShareBrowser share={s} onClose={() => window.UI.closeModal()} />
    );
  };
  const deleteShare = async (s) => {
    const ok = await window.UI.confirm({
      title: `Delete share '${s.name}'?`,
      body: (
        <>
          <p className="modal-body-text">The Samba export will be removed and clients will be disconnected.</p>
          <p className="modal-body-text muted"><b>Files at {s.path} are NOT deleted</b> — only the SMB share definition.</p>
        </>
      ),
      confirmLabel: 'Delete share',
      dangerous: true,
    });
    if (ok) {
      try {
        await axios.delete(`/api/samba/shares/${s.name}`);
        window.UI.toast({ kind: 'ok', title: 'Share removed', body: `//${window.location.hostname}/${s.name}` });
        fetchShares();
      } catch (e) {
        window.UI.toast({ kind: 'err', title: 'Failed to delete', body: e.message });
      }
    }
  };

  return (
    <div className="samba-shares">
      <div className="samba-toolbar">
        <div className="search small"><span className="search-icon">⌕</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shares…" /></div>
        <button className="btn-accent" onClick={newShare}>+ New share</button>
      </div>
      <div className="share-grid">
        {filtered.map(s => (
          <div key={s.name} className="share-card">
            <div className="share-head">
              <div className="share-name mono">//{window.location.hostname}/{s.name}</div>
              <div className={`status-pill ${s.readOnly ? 'st-warn' : 'st-running'}`}>{s.readOnly ? 'read-only' : 'rw'}</div>
            </div>
            <div className="share-path mono muted">{s.path}</div>
            <div className="share-stats">
              <div><span className="lbl">size</span><b className="mono">{s.size || '—'}</b></div>
              <div><span className="lbl">guest</span><b>{s.guest ? 'yes' : 'no'}</b></div>
            </div>
            {s.users && s.users.length > 0 && (
              <div className="share-users">
                {s.users.map(u => <span key={u} className="user-tag mono">{u}</span>)}
              </div>
            )}
            <div className="share-actions">
              <button className="btn-ghost sm" onClick={() => editShare(s)}>Edit</button>
              <button className="btn-ghost sm" onClick={() => browseShare(s)}>Browse</button>
              <button className="btn-ghost sm danger" onClick={() => deleteShare(s)}>Delete</button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && <div className="empty muted">no shares match "{q}"</div>}
      </div>
    </div>
  );
}

function AddSambaUserModal({ onSave, onClose }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [systemUsers, setSystemUsers] = useState([]);

  useEffect(() => {
    axios.get('/api/samba/users')
      .then(res => setSystemUsers(res.data.systemUsers || []))
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!username) {
      window.UI.toast({ kind: 'err', title: 'Missing username' });
      return;
    }
    try {
      await axios.post('/api/samba/users', { username, password });
      window.UI.toast({ kind: 'ok', title: 'User added', body: username });
      onSave();
      onClose();
    } catch (err) {
      window.UI.toast({ kind: 'err', title: 'Failed to create user', body: err.response?.data?.error || err.message });
    }
  };

  return (
    <Modal
      title="Add Samba user"
      subtitle="Creates an smbpasswd entry. The system Unix user must exist (or will be added)."
      onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-accent" onClick={handleSave}>Create</button>
      </>}
    >
      <div className="form-cols">
        <FormField label="Username" span={2}>
          {systemUsers.length > 0 ? (
            <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
              <input value={username} onChange={(e) => setUsername(e.target.value)} className="mono" placeholder="ayman" autoFocus style={{ flex: 1 }} />
              <select value={username} onChange={(e) => setUsername(e.target.value)} style={{ background: 'none', border: '1px solid var(--line)', padding: '6px', borderRadius: '4px', color: 'inherit' }}>
                <option value="">-- Choose Unix user --</option>
                {systemUsers.map(u => (
                  <option key={u.username} value={u.username}>{u.username}</option>
                ))}
              </select>
            </div>
          ) : (
            <input value={username} onChange={(e) => setUsername(e.target.value)} className="mono" placeholder="ayman" autoFocus />
          )}
        </FormField>
        <FormField label="Password" span={2}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}

function SambaUsers() {
  const [users, setUsers] = useState([]);

  const fetchUsers = async () => {
    try {
      const res = await axios.get('/api/samba/users');
      const mapped = (res.data.sambaUsers || []).map(u => ({
        name: u.username,
        uid: u.uid,
        fullName: u.fullName || u.username,
        shares: 0,
        lastSeen: 'never'
      }));
      setUsers(mapped);
    } catch (e) {}
  };

  useEffect(() => { fetchUsers(); }, []);

  const removeUser = async (u) => {
    const ok = await window.UI.confirm({
      title: `Remove Samba user '${u.name}'?`,
      body: 'The Samba account will be removed. Underlying system user is unaffected.',
      confirmLabel: 'Remove user',
      dangerous: true,
    });
    if (ok) {
      try {
        await axios.delete(`/api/samba/users/${u.name}`);
        window.UI.toast({ kind: 'ok', title: 'User removed', body: u.name });
        fetchUsers();
      } catch (e) {
        window.UI.toast({ kind: 'err', title: 'Remove failed', body: e.message });
      }
    }
  };

  const resetPw = async (u) => {
    let pw = '';
    window.UI.modal(
      <Modal
        title={`Set password for ${u.name}`}
        subtitle="Update password in smbpasswd"
        onClose={() => window.UI.closeModal()}
        footer={<>
          <button type="button" className="btn-ghost" onClick={() => window.UI.closeModal()}>Cancel</button>
          <button type="button" className="btn-accent" onClick={async () => {
            try {
              await axios.post('/api/samba/users', { username: u.name, password: pw });
              window.UI.closeModal();
              window.UI.toast({ kind: 'ok', title: 'Password updated', body: u.name });
            } catch (err) {
              window.UI.toast({ kind: 'err', title: 'Failed to set password', body: err.message });
            }
          }}>Set password</button>
        </>}
      >
        <div className="form-cols">
          <FormField label="New password" span={2}>
            <input type="password" onChange={(e) => { pw = e.target.value; }} autoFocus />
          </FormField>
        </div>
      </Modal>
    );
  };

  const addUser = () => {
    window.UI.modal(
      <AddSambaUserModal
        onSave={() => fetchUsers()}
        onClose={() => window.UI.closeModal()}
      />
    );
  };

  return (
    <div className="samba-users">
      <div className="samba-toolbar">
        <button className="btn-accent" onClick={addUser}>+ Add user</button>
      </div>
      <table className="samba-table mono" style={{ width: '100%' }}>
        <thead><tr><th>Username</th><th>Shares</th><th>Last seen</th><th></th></tr></thead>
        <tbody>
          {users.map(u => (
            <tr key={u.name}>
              <td><b>{u.name}</b></td>
              <td>{u.shares || 0}</td>
              <td className="muted">{u.lastSeen || 'never'}</td>
              <td className="row-actions">
                <button className="btn-ghost sm" onClick={() => resetPw(u)}>Reset password</button>
                <button className="btn-ghost sm danger" onClick={() => removeUser(u)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SambaConnections() {
  const [conns, setConns] = useState([]);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const fetchConnections = async () => {
    try {
      const res = await axios.get('/api/samba/connections');
      if (mountedRef.current) setConns(res.data || []);
    } catch (e) {}
  };

  useEffect(() => {
    fetchConnections();
    const interval = setInterval(fetchConnections, 3000);
    return () => clearInterval(interval);
  }, []);

  const disconnect = async (c) => {
    const ok = await window.UI.confirm({
      title: `Disconnect ${c.username || c.user}@${c.machine || c.client}?`,
      body: `Active SMB session on //${window.location.hostname}/${c.service || c.share} will be force-closed.`,
      confirmLabel: 'Disconnect',
      dangerous: true,
    });
    if (ok) {
      try {
        await axios.delete(`/api/samba/connections/${c.pid}`);
        window.UI.toast({ kind: 'ok', title: 'Disconnected', body: `${c.username || c.user} disconnected.` });
        fetchConnections();
      } catch (e) {
        window.UI.toast({ kind: 'err', title: 'Failed to disconnect', body: e.message });
      }
    }
  };

  return (
    <div className="samba-connections">
      <table className="samba-table mono" style={{ width: '100%' }}>
        <thead><tr><th>Client</th><th>User</th><th>Share</th><th>PID</th><th>Connected At</th><th></th></tr></thead>
        <tbody>
          {conns.map((c, i) => (
            <tr key={c.pid ? `p-${c.pid}` : `c-${i}`}>
              <td><b>{c.machine || c.client}</b></td>
              <td>{c.username || c.user}</td>
              <td>//{c.service || c.share}</td>
              <td>{c.pid}</td>
              <td className="muted">{c.connectedAt || c.since || '—'}</td>
              <td className="row-actions"><button className="btn-ghost sm danger" onClick={() => disconnect(c)}>Disconnect</button></td>
            </tr>
          ))}
          {conns.length === 0 && <tr><td colSpan={6}><div className="empty muted">no active connections</div></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function SambaSettings() {
  const [settings, setSettings] = useState({ workgroup: 'WORKGROUP', serverString: '', netbiosName: '', security: 'user' });

  useEffect(() => {
    axios.get('/api/samba/global')
      .then(res => setSettings(res.data))
      .catch(() => {});
  }, []);

  const save = async () => {
    const ok = await window.UI.confirm({
      title: 'Save & restart Samba?',
      body: 'Global settings will be applied and smbd/nmbd will restart.',
      confirmLabel: 'Save & restart',
    });
    if (ok) {
      try {
        await axios.post('/api/samba/global', settings);
        window.UI.toast({ kind: 'ok', title: 'Settings applied', body: 'Samba restarted.' });
      } catch (e) {
        window.UI.toast({ kind: 'err', title: 'Failed to apply settings', body: e.message });
      }
    }
  };

  return (
    <div className="samba-settings">
      <div className="form-grid">
        <label className="field">
          <span>Workgroup</span>
          <input value={settings.workgroup} onChange={(e) => setSettings({ ...settings, workgroup: e.target.value })} />
        </label>
        <label className="field">
          <span>Server string</span>
          <input value={settings.serverString} onChange={(e) => setSettings({ ...settings, serverString: e.target.value })} />
        </label>
        <label className="field">
          <span>NetBIOS name</span>
          <input value={settings.netbiosName} onChange={(e) => setSettings({ ...settings, netbiosName: e.target.value })} />
        </label>
      </div>
      <div className="settings-actions">
        <button className="btn-accent" onClick={save}>Save & restart</button>
      </div>
    </div>
  );
}

function SambaLogs() {
  const [logs, setLogs] = useState('');

  const fetchLogs = async () => {
    try {
      const res = await axios.get('/api/samba/logs');
      setLogs(res.data.logs || 'No log data available.');
    } catch (e) {
      setLogs(`Error loading logs: ${e.message}`);
    }
  };

  useEffect(() => { fetchLogs(); }, []);

  return (
    <div className="samba-logs">
      <div className="samba-toolbar">
        <button className="btn-ghost" onClick={fetchLogs}>↻ Refresh</button>
      </div>
      <pre className="logbox mono" style={{ maxHeight: '350px', overflow: 'auto', background: 'var(--bg-2)', padding: '12px', border: '1px solid var(--line)', borderRadius: '6px' }}>
        {logs}
      </pre>
    </div>
  );
}

function FileEditorModal({ file, onClose }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [isText, setIsText] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await axios.get('/api/files/view', { params: { path: file.path } });
        if (cancelled) return;
        if (res.data && res.data.isText) {
          setIsText(true);
          setContent(res.data.content);
        } else {
          setIsText(false);
        }
      } catch (e) {
        if (cancelled) return;
        window.UI.toast({ kind: 'err', title: 'Load failed', body: e.message });
        onClose();
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [file.path, onClose]);

  const save = async () => {
    setSaving(true);
    try {
      await axios.post('/api/files/save', { path: file.path, content });
      window.UI.toast({ kind: 'ok', title: 'File saved', body: file.name });
      onClose();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Save failed', body: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Edit · ${file.name}`}
      subtitle={file.path}
      onClose={onClose}
      size="lg"
      footer={<>
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        {isText && <button type="button" className="btn-accent" disabled={saving || loading} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>}
      </>}
    >
      {loading ? (
        <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-3)' }}>Loading file content…</div>
      ) : isText ? (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          style={{
            width: '100%',
            height: '400px',
            fontFamily: 'monospace',
            fontSize: '13px',
            background: 'var(--bg-2)',
            border: '1px solid var(--line)',
            borderRadius: '6px',
            padding: '12px',
            color: 'inherit',
            resize: 'vertical'
          }}
        />
      ) : (
        <div style={{ padding: '48px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-2)', marginBottom: '16px' }}>Binary file format ({file.name.split('.').pop()}) cannot be edited directly.</p>
          <a href={`/api/files/view?path=${encodeURIComponent(file.path)}`} target="_blank" rel="noreferrer" className="btn-accent" style={{ display: 'inline-block', padding: '8px 16px', borderRadius: '4px', textDecoration: 'none' }}>
            Download file ↗
          </a>
        </div>
      )}
    </Modal>
  );
}

// ---------- FILE BROWSER HELPERS ----------
const FILE_ICONS = {
  js:'⬡', jsx:'⬡', ts:'⬡', tsx:'⬡', mjs:'⬡',
  json:'{}', jsonc:'{}',
  yaml:'☰', yml:'☰', toml:'☰',
  md:'✎', txt:'✎', rst:'✎',
  py:'⌗', sh:'⌨', bash:'⌨', zsh:'⌨', fish:'⌨',
  jpg:'▣', jpeg:'▣', png:'▣', gif:'▣', svg:'▣', webp:'▣', ico:'▣', bmp:'▣',
  pdf:'▤',
  zip:'⊞', tar:'⊞', gz:'⊞', bz2:'⊞', xz:'⊞', '7z':'⊞', rar:'⊞',
  mp4:'▶', mkv:'▶', avi:'▶', mov:'▶', mp3:'♫', flac:'♫', ogg:'♫',
  log:'≡', conf:'⚙', cfg:'⚙', ini:'⚙', env:'⚙', service:'⚙',
  html:'◈', htm:'◈', css:'◈', xml:'◈', vue:'◈', svelte:'◈',
  go:'⬡', rs:'⬡', c:'⬡', cpp:'⬡', h:'⬡', java:'⬡', rb:'⬡',
  sql:'▧', db:'▧', sqlite:'▧',
};
const FILE_COLORS = {
  js:'oklch(0.78 0.14 78)', jsx:'oklch(0.78 0.14 200)', ts:'oklch(0.78 0.14 220)', tsx:'oklch(0.78 0.14 200)', mjs:'oklch(0.78 0.14 78)',
  json:'oklch(0.78 0.12 78)', jsonc:'oklch(0.78 0.12 78)',
  yaml:'oklch(0.78 0.12 285)', yml:'oklch(0.78 0.12 285)', toml:'oklch(0.72 0.10 30)',
  md:'oklch(0.78 0.10 150)', txt:'var(--text-3)', rst:'var(--text-3)',
  py:'oklch(0.78 0.14 220)', sh:'oklch(0.78 0.12 150)', bash:'oklch(0.78 0.12 150)',
  jpg:'oklch(0.78 0.14 30)', jpeg:'oklch(0.78 0.14 30)', png:'oklch(0.78 0.14 30)', gif:'oklch(0.78 0.14 30)', svg:'oklch(0.78 0.14 30)', webp:'oklch(0.78 0.14 30)',
  pdf:'oklch(0.78 0.14 18)',
  html:'oklch(0.78 0.14 18)', css:'oklch(0.78 0.14 220)', xml:'oklch(0.72 0.10 78)',
  log:'oklch(0.68 0.08 78)', conf:'oklch(0.68 0.08 180)', cfg:'oklch(0.68 0.08 180)', service:'oklch(0.68 0.08 180)',
  go:'oklch(0.78 0.14 200)', rs:'oklch(0.78 0.14 18)', c:'oklch(0.68 0.10 220)', cpp:'oklch(0.68 0.10 220)',
  sql:'oklch(0.78 0.12 60)',
};
function fileExt(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
function fileIcon(name) { return FILE_ICONS[fileExt(name)] || '▢'; }
function fileColor(name) { return FILE_COLORS[fileExt(name)] || 'var(--text-3)'; }

const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','svg','ico','bmp','tiff']);
const PDF_EXTS   = new Set(['pdf']);
const VIDEO_EXTS = new Set(['mp4','webm','ogg','mov','mkv']);
const AUDIO_EXTS = new Set(['mp3','wav','ogg','m4a','flac','aac']);

function renderMarkdown(raw) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const safeHref = (h) => /^(https?:\/\/|mailto:|\/|\.\/|#)/i.test(String(h || '')) ? h : '#';
  const inline = s => s
    .replace(/`([^`]+)`/g, (_,c) => `<code class="md-ic">${c}</code>`)
    .replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/~~(.+?)~~/g,'<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${esc(safeHref(href))}" target="_blank" rel="noreferrer">${text}</a>`);
  const lines = raw.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = esc(line.slice(3).trim());
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(esc(lines[i])); i++; }
      i++;
      out.push(`<pre class="md-pre"><code class="lang-${lang}">${code.join('\n')}</code></pre>`);
      continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.*)/);
    if (hm) {
      const n = hm[1].length;
      const sz = ['1.8em','1.5em','1.25em','1.1em','1em','0.95em'][n-1];
      out.push(`<h${n} style="font-size:${sz};font-weight:600;margin:1em 0 0.4em;border-bottom:${n<=2?'1px solid var(--line)':'none'};padding-bottom:${n<=2?'0.3em':'0'}">${inline(esc(hm[2]))}</h${n}>`);
      i++; continue;
    }
    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push('<hr style="border:none;border-top:1px solid var(--line);margin:1em 0"/>');
      i++; continue;
    }
    if (line.startsWith('> ')) {
      const bq = [];
      while (i < lines.length && lines[i].startsWith('> ')) { bq.push(inline(esc(lines[i].slice(2)))); i++; }
      out.push(`<blockquote style="border-left:3px solid var(--accent);padding:4px 12px;margin:8px 0;color:var(--text-2)">${bq.join('<br>')}</blockquote>`);
      continue;
    }
    if (/^[-*+]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(`<li>${inline(esc(lines[i].replace(/^[-*+]\s+/,'')))}</li>`);
        i++;
      }
      out.push(`<ul style="padding-left:20px;margin:6px 0">${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(`<li>${inline(esc(lines[i].replace(/^\d+\.\s+/,'')))}</li>`);
        i++;
      }
      out.push(`<ol style="padding-left:20px;margin:6px 0">${items.join('')}</ol>`);
      continue;
    }
    if (!line.trim()) { out.push('<br>'); i++; continue; }
    out.push(`<p style="margin:4px 0;line-height:1.7">${inline(esc(line))}</p>`);
    i++;
  }
  return out.join('\n');
}

// ---------- FILE VIEWER ----------
function FileViewer({ file, loading, onClose, onDelete, onSaved }) {
  const ext = fileExt(file.name);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = () => { setEditContent(file.content || ''); setEditMode(true); };
  const cancelEdit = () => setEditMode(false);

  const save = async () => {
    setSaving(true);
    try {
      await axios.post('/api/files/save', { path: file.path, content: editContent });
      setEditMode(false);
      onSaved(editContent);
      window.UI.toast({ kind: 'ok', title: 'Saved', body: file.name });
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Save failed', body: e.response?.data?.error || e.message });
    } finally { setSaving(false); }
  };

  const renderBody = () => {
    if (loading) return <div style={{ padding:32, textAlign:'center', color:'var(--text-3)' }}>Loading…</div>;
    if (file.isImage) return (
      <div style={{ padding:16, textAlign:'center', background:'var(--bg)', borderRadius:6 }}>
        <img src={`/api/files/view?path=${encodeURIComponent(file.path)}`} alt={file.name}
          style={{ maxWidth:'100%', maxHeight:'70vh', objectFit:'contain', borderRadius:4 }} />
      </div>
    );
    if (file.isPdf) return (
      <iframe src={`/api/files/view?path=${encodeURIComponent(file.path)}`}
        style={{ width:'100%', height:'70vh', border:0 }} title={file.name} />
    );
    if (file.isVideo) return (
      <div style={{ padding:16, textAlign:'center', background:'var(--bg)', borderRadius:6 }}>
        <video controls src={`/api/files/view?path=${encodeURIComponent(file.path)}`}
          style={{ maxWidth:'100%', maxHeight:'70vh', borderRadius:4, outline:'none' }} />
      </div>
    );
    if (file.isAudio) return (
      <div style={{ padding:'32px 16px', textAlign:'center', background:'var(--bg)', borderRadius:6, display:'flex', flexDirection:'column', alignItems:'center', gap:12 }}>
        <div style={{ fontSize:48, color:'var(--accent)' }}>♫</div>
        <div style={{ fontSize:13, fontWeight:500 }}>{file.name}</div>
        <audio controls src={`/api/files/view?path=${encodeURIComponent(file.path)}`}
          style={{ width:'100%', maxWidth:400, outline:'none' }} />
      </div>
    );
    if (file.isBinary) return (
      <div style={{ padding:32, textAlign:'center' }}>
        <div style={{ color:'var(--text-3)', marginBottom:12, fontSize:13 }}>Binary file — cannot display inline.</div>
        <a href={`/api/files/view?path=${encodeURIComponent(file.path)}`} target="_blank" rel="noreferrer"
          className="btn-accent" style={{ textDecoration:'none', display:'inline-block', padding:'8px 16px' }}>
          Download / Open ↗
        </a>
      </div>
    );
    if (editMode) {
      const getEditorLanguage = (fileName) => {
        const ext = fileName.split('.').pop().toLowerCase();
        switch (ext) {
          case 'js': case 'jsx': return 'javascript';
          case 'ts': case 'tsx': return 'typescript';
          case 'html': return 'html';
          case 'css': return 'css';
          case 'json': return 'json';
          case 'py': return 'python';
          case 'sh': case 'bash': return 'shell';
          case 'yml': case 'yaml': return 'yaml';
          case 'md': return 'markdown';
          case 'go': return 'go';
          case 'rs': return 'rust';
          case 'c': case 'cpp': return 'cpp';
          case 'java': return 'java';
          case 'php': return 'php';
          case 'sql': return 'sql';
          case 'xml': return 'xml';
          default: return 'plaintext';
        }
      };
      return (
        <div style={{ height: '65vh', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
          <Editor
            height="100%"
            theme="vs-dark"
            language={getEditorLanguage(file.name)}
            value={editContent}
            onChange={val => setEditContent(val || '')}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              fontFamily: 'monospace',
              lineNumbers: 'on',
              roundedSelection: false,
              scrollBeyondLastLine: false,
              readOnly: false,
              automaticLayout: true,
              wordWrap: 'on',
            }}
          />
        </div>
      );
    }
    const content = file.content || '';
    if (ext === 'md') return (
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
        style={{ padding:'16px 24px', lineHeight:1.7, fontSize:14 }} />
    );
    if (ext === 'json') {
      let pretty = content;
      try { pretty = JSON.stringify(JSON.parse(content), null, 2); } catch {}
      return <pre style={{ padding:'12px 16px', margin:0, fontSize:12, lineHeight:1.6, color:'var(--text-2)', overflowX:'auto', whiteSpace:'pre-wrap', wordBreak:'break-all' }}>{pretty}</pre>;
    }
    return <pre style={{ padding:'12px 16px', margin:0, fontSize:12, lineHeight:1.6, color:'var(--text-2)', overflowX:'auto', whiteSpace:'pre-wrap', wordBreak:'break-all' }}>{content}</pre>;
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', gap:8 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', background:'var(--bg-2)', borderRadius:6, border:'1px solid var(--line)', flexWrap:'wrap' }}>
        <button className="btn-ghost sm" onClick={onClose} style={{ flexShrink:0 }}>← Back</button>
        <span style={{ fontFamily:'monospace', fontSize:12, color:'var(--text-3)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{file.path}</span>
        <div style={{ display:'flex', gap:6, flexShrink:0 }}>
          {file.isText && !editMode && <button className="btn-ghost sm" onClick={startEdit}>Edit</button>}
          {editMode && <button className="btn-accent sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>}
          {editMode && <button className="btn-ghost sm" onClick={cancelEdit}>Cancel</button>}
          <a href={`/api/files/view?path=${encodeURIComponent(file.path)}`} target="_blank" rel="noreferrer"
            style={{ textDecoration:'none' }}><button className="btn-ghost sm">Download ↗</button></a>
          <button className="btn-ghost sm" style={{ color:'var(--err)' }} onClick={onDelete}>Delete</button>
        </div>
      </div>
      <div className="card" style={{ flex:1, overflow:'auto', padding:0 }}>
        {renderBody()}
      </div>
    </div>
  );
}

// ---------- BACKUPS ----------
function BackupJobModal({ job, onSave, onClose }) {
  const [name, setName] = useState(job.name || '');
  const [src, setSrc] = useState(job.src || '');
  const [destType, setDestType] = useState(job.destType || 'local');
  const [dest, setDest] = useState(job.dest || '');
  const [schedule, setSchedule] = useState(job.schedule || '');
  const [active, setActive] = useState(job.active !== false);
  const [args, setArgs] = useState(job.args || '');

  const handleSave = (e) => {
    e.preventDefault();
    if (!name.trim() || !src.trim() || !dest.trim()) {
      window.UI.toast({ kind: 'err', title: 'Missing fields', body: 'Name, Source Path, and Destination Path are required.' });
      return;
    }
    const payload = {
      id: job.id,
      name: name.trim(),
      src: src.trim(),
      destType,
      dest: dest.trim(),
      schedule: schedule.trim(),
      active,
      args: args.trim()
    };
    onSave(payload);
  };

  const setPreset = (preset) => {
    setSchedule(preset);
  };

  return (
    <Modal
      title={job.id ? `Edit Backup Job: ${job.name}` : 'Create Backup Job'}
      subtitle={job.id ? 'Modify sync settings and schedule' : 'Set up automated file syncs or archive tasks'}
      icon={job.id ? '✎' : '💾'}
      onClose={onClose}
    >
      <form onSubmit={handleSave} className="form-cols">
        <FormField label="Job Name" span={2}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Daily Projects Backup" autoFocus className="mono" required />
        </FormField>
        
        <FormField label="Source Path (on host)" span={2} hint="Absolute directory path containing files to backup.">
          <input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="e.g. /home/ayman/projects/hosted-dashboard/backend/data" className="mono" required />
        </FormField>

        <FormField label="Sync / Backup Tool" span={2}>
          <select value={destType} onChange={(e) => setDestType(e.target.value)}>
            <option value="local">Local Archive / Directory (tar / rsync)</option>
            <option value="rclone">Rclone Sync (supports Cloud: Google Drive, S3, etc.)</option>
            <option value="rsync">Rsync over SSH (Remote Server)</option>
          </select>
        </FormField>

        <FormField
          label="Destination Path / Target"
          span={2}
          hint={
            destType === 'local' ? "Absolute path. If ends with .tar.gz / .tgz, creates a compressed archive (e.g. /opt/backups/data.tar.gz). Otherwise, copies via rsync."
            : destType === 'rclone' ? "Rclone remote name and path (e.g. gdrive:backup_dir)."
            : "Rsync target string (e.g. ayman@10.0.0.50:/home/ayman/remote_backup)."
          }
        >
          <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder={destType === 'local' ? '/var/backups/dashboard_data.tar.gz' : destType === 'rclone' ? 'gdrive:backups' : 'user@192.168.1.100:/backups'} className="mono" required />
        </FormField>

        <FormField label="Schedule (Cron Expression)" span={2} hint="Leave empty for manual execution only. System uses standard cron syntax.">
          <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="e.g. 0 2 * * * (Every day at 2 AM)" className="mono" />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn-ghost sm" onClick={() => setPreset('*/5 * * * *')}>Every 5 mins</button>
            <button type="button" className="btn-ghost sm" onClick={() => setPreset('0 * * * *')}>Hourly</button>
            <button type="button" className="btn-ghost sm" onClick={() => setPreset('0 0 * * *')}>Daily (Midnight)</button>
            <button type="button" className="btn-ghost sm" onClick={() => setPreset('0 0 * * 0')}>Weekly (Sunday)</button>
            <button type="button" className="btn-ghost sm" onClick={() => setPreset('')}>Manual Only</button>
          </div>
        </FormField>

        <FormField label="Extra Command Arguments" span={2} hint="Optional flags to pass directly to the backup tool.">
          <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder={destType === 'rclone' ? '--transfers=4 --fast-list' : destType === 'rsync' ? '--delete --exclude "*.log"' : '--exclude="node_modules"'} className="mono" />
        </FormField>

        <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <input type="checkbox" id="job-active-chk" checked={active} onChange={(e) => setActive(e.target.checked)} style={{ cursor: 'pointer' }} />
          <label htmlFor="job-active-chk" style={{ fontSize: 12, fontWeight: 'bold', cursor: 'pointer', userSelect: 'none' }}>
            Enable Automated Schedule Execution
          </label>
        </div>

        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-accent">{job.id ? 'Save changes' : 'Create job'}</button>
        </div>
      </form>
    </Modal>
  );
}

function BackupsManagerTab() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editingJob, setEditingJob] = useState(null);
  const [showLogsJob, setShowLogsJob] = useState(null);

  const loadJobs = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/backups');
      setJobs(res.data.backups || []);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed to load backups', body: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJobs();
  }, []);

  // Poll running jobs if any are active
  const anyRunning = useMemo(() => jobs.some(j => j.lastStatus === 'running'), [jobs]);
  useEffect(() => {
    if (!anyRunning) return;

    const interval = setInterval(async () => {
      try {
        const res = await axios.get('/api/backups');
        setJobs(res.data.backups || []);
      } catch (e) {}
    }, 3000);
    return () => clearInterval(interval);
  }, [anyRunning]);

  const handleDelete = async (job) => {
    const ok = await window.UI.confirm({
      title: 'Delete backup job?',
      body: `Are you sure you want to delete backup job "${job.name}"?`,
      confirmLabel: 'Delete',
      dangerous: true
    });
    if (!ok) return;
    try {
      await axios.delete(`/api/backups/${job.id}`);
      window.UI.toast({ kind: 'ok', title: 'Backup job deleted' });
      loadJobs();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed to delete job', body: e.message });
    }
  };

  const handleRun = async (job) => {
    try {
      await axios.post(`/api/backups/run/${job.id}`);
      window.UI.toast({ kind: 'ok', title: 'Backup job started', body: job.name });
      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, lastStatus: 'running', lastRun: new Date().toISOString() } : j));
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed to start backup', body: e.response?.data?.error || e.message });
    }
  };

  const handleToggle = async (job) => {
    try {
      await axios.post('/api/backups', { ...job, active: !job.active });
      window.UI.toast({ kind: 'ok', title: job.active ? 'Job disabled' : 'Job enabled', body: job.name });
      loadJobs();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed to toggle job', body: e.message });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>Cloud Sync & Backup Scheduler</h2>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Schedule automated syncs and backups using rclone, rsync, or local archives.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost" onClick={loadJobs}>↻ Reload</button>
          <button className="btn-accent" onClick={() => setEditingJob({})}>+ Add backup job</button>
        </div>
      </div>

      <div className="card" style={{ flex: 1, overflow: 'auto', padding: 0 }}>
        {loading && jobs.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading backup jobs...</div>
        ) : jobs.length === 0 ? (
          <div className="empty muted" style={{ padding: 48, textAlign: 'center' }}>
            <span style={{ fontSize: 32, display: 'block', marginBottom: 12 }}>💾</span>
            No backup jobs configured yet. Create one to sync files to remote hosts or create local archives.
          </div>
        ) : (
          <table className="proc-table mono" style={{ width: '100%', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ width: 50 }}>Active</th>
                <th>Name</th>
                <th>Source</th>
                <th>Tool</th>
                <th>Destination</th>
                <th>Schedule</th>
                <th>Last Run</th>
                <th>Status</th>
                <th style={{ width: 180, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => (
                <tr key={job.id} style={{ opacity: job.active ? 1 : 0.6 }}>
                  <td>
                    <input type="checkbox" checked={job.active} onChange={() => handleToggle(job)} title={job.active ? "Disable schedule" : "Enable schedule"} />
                  </td>
                  <td style={{ fontWeight: 'bold', color: 'var(--text-2)' }}>{job.name}</td>
                  <td style={{ fontSize: 11 }} title={job.src}>{job.src}</td>
                  <td>
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontSize: 10,
                      fontWeight: 600,
                      background: job.destType === 'rclone' ? 'oklch(0.28 0.08 200)' : job.destType === 'rsync' ? 'oklch(0.28 0.08 285)' : 'oklch(0.28 0.06 120)',
                      color: job.destType === 'rclone' ? 'oklch(0.78 0.12 200)' : job.destType === 'rsync' ? 'oklch(0.78 0.12 285)' : 'oklch(0.78 0.12 120)'
                    }}>
                      {job.destType}
                    </span>
                  </td>
                  <td style={{ fontSize: 11 }} title={job.dest}>{job.dest}</td>
                  <td style={{ color: 'var(--accent)' }}>{job.schedule || 'manual'}</td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {job.lastRun ? new Date(job.lastRun).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : 'never'}
                  </td>
                  <td>
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontSize: 10,
                      fontWeight: 600,
                      background: job.lastStatus === 'success' ? 'oklch(0.28 0.08 150)' : job.lastStatus === 'failed' ? 'oklch(0.28 0.08 18)' : job.lastStatus === 'running' ? 'var(--hover)' : 'var(--bg-2)',
                      color: job.lastStatus === 'success' ? 'oklch(0.78 0.12 150)' : job.lastStatus === 'failed' ? 'oklch(0.78 0.1 18)' : job.lastStatus === 'running' ? 'var(--accent)' : 'var(--text-3)'
                    }}>
                      {job.lastStatus === 'running' && <span className="spinner" style={{ display: 'inline-block', width: 8, height: 8, border: '1.5px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', marginRight: 4, animation: 'spin 0.8s linear infinite' }} />}
                      {job.lastStatus}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn-ghost sm" disabled={job.lastStatus === 'running'} onClick={() => handleRun(job)}>▶ Run</button>
                      <button className="btn-ghost sm" onClick={() => setShowLogsJob(job)} disabled={!job.lastLog}>Logs</button>
                      <button className="btn-ghost sm" onClick={() => setEditingJob(job)}>Edit</button>
                      <button className="icon-btn" onClick={() => handleDelete(job)} style={{ color: 'var(--err)', marginLeft: 4 }}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editingJob && (
        <BackupJobModal
          job={editingJob}
          onSave={async (payload) => {
            try {
              await axios.post('/api/backups', payload);
              window.UI.toast({ kind: 'ok', title: payload.id ? 'Backup job updated' : 'Backup job created' });
              setEditingJob(null);
              loadJobs();
            } catch (e) {
              window.UI.toast({ kind: 'err', title: 'Failed to save job', body: e.response?.data?.error || e.message });
            }
          }}
          onClose={() => setEditingJob(null)}
        />
      )}

      {showLogsJob && (
        <Modal title={`Backup Logs: ${showLogsJob.name}`} onClose={() => setShowLogsJob(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Source: <b>{showLogsJob.src}</b> | Destination: <b>{showLogsJob.dest}</b> ({showLogsJob.destType})
            </div>
            <pre style={{
              background: 'var(--bg-2)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: 12,
              maxHeight: 300,
              overflow: 'auto',
              fontSize: 11,
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              margin: 0
            }}>
              {showLogsJob.lastLog || 'No logs available.'}
            </pre>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn-accent" onClick={() => setShowLogsJob(null)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- FILES ----------
function FilesTab() {
  const [subTab, setSubTab] = useState('explorer'); // explorer, backups
  const [currentPath, setCurrentPath] = useState('/home/ayman');
  const [folders, setFolders] = useState([]);
  const [files, setFiles] = useState([]);
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [viewFile, setViewFile] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [op, setOp] = useState(null);
  const fileInputRef = useRef(null);
  const [uploadProgress, setUploadProgress] = useState(null);

  // New Search, Sort, View, and Sidebar States
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('name'); // name, size, mtime
  const [sortOrder, setSortOrder] = useState('asc'); // asc, desc
  const [viewMode, setViewMode] = useState('list'); // list, grid
  const [showSidebar, setShowSidebar] = useState(true);

  // Multi-select, drag/drop, search overlay, image preview, rename, path editor, context menu
  const [multiSelected, setMultiSelected] = useState(() => new Set());
  const [lastClickIndex, setLastClickIndex] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [renamingPath, setRenamingPath] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [pathEditing, setPathEditing] = useState(false);
  const [pathEditValue, setPathEditValue] = useState('');
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState(null);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, item, isDir }
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // Close context menu on any outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [ctxMenu]);
  const PREVIEW_IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp']);

  const [favorites, setFavorites] = useState(() => {
    const cached = localStorage.getItem('file_favorites');
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
    return [
      { name: 'Home (~)', path: '/home/ayman', icon: '🏠' },
      { name: 'System Root (/)', path: '/', icon: '💻' }
    ];
  });

  const saveFavorites = (list) => {
    setFavorites(list);
    localStorage.setItem('file_favorites', JSON.stringify(list));
  };

  const isCurrentFavorited = favorites.some(f => f.path === currentPath);
  const toggleCurrentFavorite = () => {
    if (isCurrentFavorited) {
      saveFavorites(favorites.filter(f => f.path !== currentPath));
      window.UI.toast({ kind: 'ok', title: 'Unpinned', body: `Removed current folder from favorites.` });
    } else {
      const name = currentPath.split('/').filter(Boolean).pop() || '/';
      const newFav = { name, path: currentPath, icon: '⭐' };
      saveFavorites([...favorites, newFav]);
      window.UI.toast({ kind: 'ok', title: 'Pinned', body: `Added "${name}" to favorites.` });
    }
  };

  const fetchDir = async (p, hidden = showHidden) => {
    setLoading(true);
    setViewFile(null);
    setSelected(null);
    setMultiSelected(new Set());
    setLastClickIndex(null);
    setGlobalSearchResults(null);
    setGlobalSearchQuery('');
    setRenamingPath(null);
    try {
      const res = await axios.get('/api/samba/browse', { params: { path: p, showHidden: hidden } });
      if (!mountedRef.current) return;
      setCurrentPath(res.data.currentPath);
      setFolders(res.data.folders || []);
      setFiles(res.data.files || []);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Browse error', body: e.message });
    } finally { if (mountedRef.current) setLoading(false); }
  };

  useEffect(() => { fetchDir(currentPath); }, []);

  const handleFiles = async (fileList) => {
    const filesToUpload = Array.from(fileList || []);
    if (filesToUpload.length === 0) return;

    const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunk
    for (const file of filesToUpload) {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const fileName = file.name;
      const dir = currentPath;

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const formData = new FormData();
        formData.append('chunk', chunk, fileName);
        formData.append('dir', dir);
        formData.append('fileName', fileName);
        formData.append('chunkIndex', String(chunkIndex));
        formData.append('totalChunks', String(totalChunks));

        if (mountedRef.current) setUploadProgress({
          name: fileName,
          pct: Math.round(((chunkIndex + 0.5) / totalChunks) * 100)
        });

        try {
          await axios.post('/api/files/upload-chunk', formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
          });
        } catch (err) {
          window.UI.toast({ kind: 'err', title: 'Upload failed', body: err.message });
          if (mountedRef.current) setUploadProgress(null);
          return;
        }
      }
      if (mountedRef.current) setUploadProgress({ name: fileName, pct: 100 });
      setTimeout(() => { if (mountedRef.current) setUploadProgress(null); }, 1000);
    }
    window.UI.toast({ kind: 'ok', title: 'Upload complete', body: `${filesToUpload.length} file(s) uploaded.` });
    fetchDir(currentPath);
  };

  const handleUpload = (e) => handleFiles(e.target.files);

  const createFile = async () => {
    const name = prompt('New file name:');
    if (!name) return;
    const path = currentPath.replace(/\/$/, '') + '/' + name;
    try {
      await axios.post('/api/files/save', { path, content: '' });
      window.UI.toast({ kind: 'ok', title: 'Created file', body: name });
      fetchDir(currentPath);
      openFile({ name, path, isText: true, content: '' });
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed to create file', body: e.response?.data?.error || e.message });
    }
  };

  const crumbs = useMemo(() => {
    const parts = currentPath.split('/').filter(Boolean);
    const acc = [];
    return [{ name: '/', path: '/' }].concat(
      parts.map(p => { acc.push(p); return { name: p, path: '/' + acc.join('/') }; })
    );
  }, [currentPath]);

  const parseSize = (sizeStr) => {
    if (!sizeStr || sizeStr === '—') return 0;
    const match = sizeStr.match(/^([\d.]+)\s*([a-zA-Z]+)/);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit.startsWith('G')) return val * 1e9;
    if (unit.startsWith('M')) return val * 1e6;
    if (unit.startsWith('K')) return val * 1e3;
    return val;
  };

  // Local Search & Sort logic
  const filteredFolders = useMemo(() => {
    let res = folders;
    if (searchQuery) {
      res = res.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()));
    }
    return [...res].sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (sortBy === 'size') return 0; // folders don't have sizes
      if (typeof valA === 'string') {
        const comp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
        return sortOrder === 'asc' ? comp : -comp;
      }
      return 0;
    });
  }, [folders, searchQuery, sortBy, sortOrder]);

  const filteredFiles = useMemo(() => {
    let res = files;
    if (searchQuery) {
      res = res.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()));
    }
    return [...res].sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (sortBy === 'size') {
        valA = parseSize(a.size);
        valB = parseSize(b.size);
      }
      if (typeof valA === 'string') {
        const comp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
        return sortOrder === 'asc' ? comp : -comp;
      } else {
        if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
        return 0;
      }
    });
  }, [files, searchQuery, sortBy, sortOrder]);

  const selectedItem = useMemo(() => {
    if (!selected) return null;
    const f = folders.find(x => x.name === selected);
    if (f) return { ...f, isDir: true };
    return files.find(x => x.name === selected) || null;
  }, [selected, folders, files]);

  const statsSummary = useMemo(() => {
    let totalBytes = 0;
    files.forEach(f => {
      totalBytes += parseSize(f.size);
    });
    let sizeFormatted = '0 B';
    if (totalBytes > 1e9) sizeFormatted = (totalBytes / 1e9).toFixed(2) + ' GB';
    else if (totalBytes > 1e6) sizeFormatted = (totalBytes / 1e6).toFixed(1) + ' MB';
    else if (totalBytes > 1024) sizeFormatted = (totalBytes / 1024).toFixed(0) + ' KB';
    else if (totalBytes > 0) sizeFormatted = totalBytes + ' B';

    return {
      foldersCount: folders.length,
      filesCount: files.length,
      totalSize: sizeFormatted
    };
  }, [folders, files]);

  const clickTimer = useRef(null);
  useEffect(() => () => { if (clickTimer.current) clearTimeout(clickTimer.current); }, []);
  const handleRowClick = (item, isDir) => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      if (isDir) fetchDir(item.path);
      else openFile(item);
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null;
        setSelected(prev => prev === item.name ? null : item.name);
        if (!isDir && PREVIEW_IMAGE_EXTS.has(fileExt(item.name)) && previewOpen) {
          setPreviewFile({ ...item, kind: 'image' });
        } else if (!isDir && fileExt(item.name) === 'pdf' && previewOpen) {
          setPreviewFile({ ...item, kind: 'pdf' });
        }
      }, 220);
    }
  };

  const openFile = async (file) => {
    setViewLoading(true);
    setViewFile(null);
    const ext = fileExt(file.name);
    try {
      if (IMAGE_EXTS.has(ext)) {
        setViewFile({ ...file, isImage: true });
      } else if (PDF_EXTS.has(ext)) {
        setViewFile({ ...file, isPdf: true });
      } else if (VIDEO_EXTS.has(ext)) {
        setViewFile({ ...file, isVideo: true });
      } else if (AUDIO_EXTS.has(ext)) {
        setViewFile({ ...file, isAudio: true });
      } else {
        const res = await axios.get('/api/files/view', { params: { path: file.path } });
        if (res.data.isText) {
          setViewFile({ ...file, isText: true, content: res.data.content });
        } else {
          setViewFile({ ...file, isBinary: true });
        }
      }
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Cannot open file', body: e.message });
    } finally { setViewLoading(false); }
  };

  const deleteItem = async (item) => {
    const ok = await window.UI.confirm({
      title: `Delete "${item.name}"?`,
      body: 'This action cannot be undone.',
      confirmLabel: 'Delete', dangerous: true,
    });
    if (!ok) return;
    try {
      await axios.delete('/api/files', { params: { path: item.path } });
      window.UI.toast({ kind: 'ok', title: 'Deleted', body: item.name });
      if (viewFile?.path === item.path) setViewFile(null);
      setSelected(null);
      fetchDir(currentPath);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Delete failed', body: e.response?.data?.error || e.message });
    }
  };

  const commitOp = async () => {
    if (!op) return;
    const dir = currentPath.replace(/\/$/, '');
    try {
      if (op.type === 'rename') {
        await axios.post('/api/files/move', { from: op.item.path, to: dir + '/' + op.value });
        window.UI.toast({ kind: 'ok', title: 'Renamed', body: op.value });
      } else if (op.type === 'copy') {
        await axios.post('/api/files/copy', { from: op.item.path, to: op.value });
        window.UI.toast({ kind: 'ok', title: 'Copied', body: op.item.name });
      } else if (op.type === 'move') {
        await axios.post('/api/files/move', { from: op.item.path, to: op.value });
        window.UI.toast({ kind: 'ok', title: 'Moved', body: op.item.name });
      } else if (op.type === 'mkdir') {
        await axios.post('/api/files/mkdir', { path: dir + '/' + op.value });
        window.UI.toast({ kind: 'ok', title: 'Created', body: op.value });
      }
      setOp(null);
      fetchDir(currentPath);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed', body: e.response?.data?.error || e.message });
    }
  };

  // Combined ordered list of visible rows used to compute shift-click ranges
  const visibleRows = useMemo(() => {
    const dirs = filteredFolders.map(f => ({ ...f, isDir: true }));
    const fls = filteredFiles.map(f => ({ ...f, isDir: false }));
    return [...dirs, ...fls];
  }, [filteredFolders, filteredFiles]);

  const toggleRowChecked = (item, idx, ev) => {
    ev.stopPropagation();
    setMultiSelected(prev => {
      const next = new Set(prev);
      if (ev.shiftKey && lastClickIndex !== null) {
        const [a, b] = [Math.min(lastClickIndex, idx), Math.max(lastClickIndex, idx)];
        for (let i = a; i <= b; i++) {
          const r = visibleRows[i];
          if (r) next.add(r.path);
        }
      } else {
        if (next.has(item.path)) next.delete(item.path);
        else next.add(item.path);
      }
      return next;
    });
    setLastClickIndex(idx);
  };

  const toggleSelectAllVisible = () => {
    setMultiSelected(prev => {
      const all = visibleRows.map(r => r.path);
      const allChecked = all.length > 0 && all.every(p => prev.has(p));
      if (allChecked) return new Set();
      return new Set(all);
    });
  };

  const clearMultiSelect = () => { setMultiSelected(new Set()); setLastClickIndex(null); };

  const bulkDelete = async () => {
    const paths = Array.from(multiSelected);
    if (paths.length === 0) return;
    const ok = await window.UI.confirm({
      title: `Delete ${paths.length} item${paths.length === 1 ? '' : 's'}?`,
      body: 'This action cannot be undone.',
      confirmLabel: 'Delete', dangerous: true,
    });
    if (!ok) return;
    let failures = 0;
    for (const p of paths) {
      try {
        await axios.post('/api/files/trash', { path: p });
      } catch (e) {
        try { await axios.delete('/api/files', { params: { path: p } }); }
        catch (e2) { failures++; }
      }
    }
    if (failures === 0) window.UI.toast({ kind: 'ok', title: 'Deleted', body: `${paths.length} item(s)` });
    else window.UI.toast({ kind: 'warn', title: 'Partial delete', body: `${failures} failed of ${paths.length}` });
    clearMultiSelect();
    fetchDir(currentPath);
  };

  const bulkMoveOrCopy = async (action) => {
    const paths = Array.from(multiSelected);
    if (paths.length === 0) return;
    const dest = prompt(`Destination directory for ${paths.length} item(s):`, currentPath);
    if (!dest) return;
    let failures = 0;
    for (const p of paths) {
      const base = p.split('/').pop();
      const to = dest.replace(/\/$/, '') + '/' + base;
      try {
        await axios.post(action === 'move' ? '/api/files/move' : '/api/files/copy', { from: p, to });
      } catch (e) { failures++; }
    }
    if (failures === 0) window.UI.toast({ kind: 'ok', title: action === 'move' ? 'Moved' : 'Copied', body: `${paths.length} item(s)` });
    else window.UI.toast({ kind: 'warn', title: 'Partial ' + action, body: `${failures} failed of ${paths.length}` });
    clearMultiSelect();
    fetchDir(currentPath);
  };

  const bulkCompress = async (download = false) => {
    const paths = Array.from(multiSelected);
    if (paths.length === 0) return;
    let target;
    if (download) {
      target = '/tmp/dashboard-zip-' + Math.random().toString(36).slice(2, 10) + '.zip';
    } else {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = prompt('Archive name:', `archive-${ts}.zip`);
      if (!name) return;
      target = currentPath.replace(/\/$/, '') + '/' + name;
    }
    try {
      await axios.post('/api/files/archive', { action: 'compress', paths, target });
      window.UI.toast({ kind: 'ok', title: 'Archive created', body: target.split('/').pop() });
      if (download) {
        const a = document.createElement('a');
        a.href = `/api/files/download?path=${encodeURIComponent(target)}`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else {
        fetchDir(currentPath);
      }
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Archive failed', body: e.response?.data?.error || e.message });
    }
    clearMultiSelect();
  };

  const startRename = (item) => {
    setRenamingPath(item.path);
    setRenameValue(item.name);
  };

  const commitRename = async (item) => {
    const newName = renameValue.trim();
    if (!newName || newName.includes('/')) {
      window.UI.toast({ kind: 'err', title: 'Invalid name', body: 'Name must be non-empty and contain no "/"' });
      return;
    }
    if (newName === item.name) { setRenamingPath(null); return; }
    const parent = item.path.replace(/\/[^/]+\/?$/, '') || '/';
    const to = (parent === '/' ? '' : parent) + '/' + newName;
    try {
      await axios.post('/api/files/move', { from: item.path, to });
      window.UI.toast({ kind: 'ok', title: 'Renamed', body: newName });
      setRenamingPath(null);
      fetchDir(currentPath);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Rename failed', body: e.response?.data?.error || e.message });
    }
  };

  const runGlobalSearch = async () => {
    const q = globalSearchQuery.trim();
    if (!q) { setGlobalSearchResults(null); return; }
    setGlobalSearchLoading(true);
    try {
      const res = await axios.get('/api/files/search', { params: { path: currentPath, q, max: 200 } });
      if (!mountedRef.current) return;
      setGlobalSearchResults(res.data.results || res.data.items || res.data || []);
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Search failed', body: e.response?.data?.error || e.message });
    } finally { if (mountedRef.current) setGlobalSearchLoading(false); }
  };

  const shareViaSamba = async (item) => {
    const name = prompt(`Samba share name for "${item.name}":`, item.name);
    if (!name) return;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      window.UI.toast({ kind: 'err', title: 'Invalid name', body: 'Use A-Z, 0-9, _ . - (max 64 chars)' });
      return;
    }
    try {
      await axios.post('/api/samba/shares', { name, path: item.path, writable: true, browsable: true, guestOk: false });
      window.UI.toast({ kind: 'ok', title: 'Share created', body: name });
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Share failed', body: e.response?.data?.error || e.message });
    }
  };

  const openContextMenu = (e, item, isDir) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, item: { ...item, isDir }, isDir });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 480 }}>
      {/* Sub tabs */}
      <div className="subnav">
        <button type="button" className={`subnav-item ${subTab === 'explorer' ? 'is-active' : ''}`} onClick={() => setSubTab('explorer')}>File Explorer</button>
        <button type="button" className={`subnav-item ${subTab === 'backups' ? 'is-active' : ''}`} onClick={() => setSubTab('backups')}>Backup Sync Manager</button>
      </div>

      {subTab === 'backups' ? (
        <BackupsManagerTab />
      ) : (
        <>
          {/* Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: 'var(--bg-2)', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--line)' }}>
        {/* Toggle Sidebar */}
        <button
          type="button"
          className="btn-ghost sm"
          onClick={() => setShowSidebar(!showSidebar)}
          title="Toggle Sidebar"
          style={{ padding: '6px 10px', fontSize: 12 }}
        >
          {showSidebar ? '📁 Sidebar' : '📂 Sidebar'}
        </button>

        {/* Path Crumbs */}
        <div style={{ display: 'flex', gap: '2px', alignItems: 'center', flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 12, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ color: 'var(--text-3)', padding: '0 2px' }}>/</span>}
              <button
                type="button"
                onClick={() => fetchDir(c.path)}
                style={{
                  background: 'none',
                  border: 0,
                  cursor: 'pointer',
                  padding: '2px 4px',
                  color: i === crumbs.length - 1 ? 'var(--text)' : 'var(--text-3)',
                  borderRadius: 3,
                  fontSize: 12,
                  fontWeight: i === crumbs.length - 1 ? 'bold' : 'normal'
                }}
              >
                {c.name}
              </button>
            </React.Fragment>
          ))}
          <button
            type="button"
            onClick={toggleCurrentFavorite}
            style={{
              background: 'none',
              border: 0,
              cursor: 'pointer',
              fontSize: 14,
              color: isCurrentFavorited ? 'oklch(0.78 0.14 78)' : 'var(--text-3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '2px 6px',
              borderRadius: 4,
              marginLeft: 4,
              transition: 'transform 0.15s ease'
            }}
            onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.15)'}
            onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
            title={isCurrentFavorited ? "Remove current folder from Favorites" : "Add current folder to Favorites"}
          >
            {isCurrentFavorited ? '★' : '☆'}
          </button>
        </div>

        {/* Live Search */}
        <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 8px', width: '100%', maxWidth: 220 }}>
          <span className="muted" style={{ marginRight: 6, fontSize: 12 }}>⌕</span>
          <input
            type="text"
            placeholder="Search folder..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{ background: 'transparent', border: 0, outline: 'none', color: 'inherit', width: '100%', fontSize: 12 }}
          />
          {searchQuery && (
            <button type="button" onClick={() => setSearchQuery('')} style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--text-3)', padding: 0, fontSize: 12 }}>✕</button>
          )}
        </div>

        {/* Mode Toggle */}
        <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
          <button
            type="button"
            className="btn-ghost sm"
            style={{
              background: viewMode === 'list' ? 'var(--hover)' : 'transparent',
              border: 0,
              borderRadius: 0,
              padding: '6px 10px',
              color: viewMode === 'list' ? 'var(--accent)' : 'inherit',
              cursor: 'pointer'
            }}
            onClick={() => setViewMode('list')}
            title="List View"
          >
            ☰
          </button>
          <button
            type="button"
            className="btn-ghost sm"
            style={{
              background: viewMode === 'grid' ? 'var(--hover)' : 'transparent',
              border: 0,
              borderRadius: 0,
              padding: '6px 10px',
              color: viewMode === 'grid' ? 'var(--accent)' : 'inherit',
              cursor: 'pointer'
            }}
            onClick={() => setViewMode('grid')}
            title="Grid View"
          >
            ▦
          </button>
        </div>

        {/* Actions */}
        <button type="button" className="btn-ghost sm" onClick={createFile}>+ File</button>
        <button type="button" className="btn-ghost sm" onClick={() => setOp({ type: 'mkdir', value: '' })}>+ Dir</button>
        <button type="button" className="btn-ghost sm" onClick={() => fileInputRef.current?.click()}>+ Upload</button>
        <button type="button" className="btn-ghost sm" title="Open this folder in the Code workspace" onClick={() => window.dispatchEvent(new CustomEvent('open-workspace', { detail: { cwd: currentPath } }))}>⌘ Open in Code</button>
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          multiple
          onChange={handleUpload}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: 'var(--text-3)', userSelect: 'none' }}>
          <input type="checkbox" checked={showHidden} onChange={e => { setShowHidden(e.target.checked); fetchDir(currentPath, e.target.checked); }} />
          hidden
        </label>
      </div>

      {/* Pending operations bar */}
      {op && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--line)' }}>
          <span style={{ fontSize: 12, color: 'var(--text-2)', flexShrink: 0 }}>
            {op.type === 'rename' ? `Rename "${op.item?.name}" to:` :
             op.type === 'copy'   ? `Copy "${op.item?.name}" to path:` :
             op.type === 'move'   ? `Move "${op.item?.name}" to path:` :
             'New folder name:'}
          </span>
          <input
            autoFocus
            value={op.value}
            onChange={e => setOp(p => ({ ...p, value: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') commitOp(); if (e.key === 'Escape') setOp(null); }}
            style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--line)', padding: '4px 8px', borderRadius: 4, color: 'inherit', fontSize: 12, fontFamily: 'var(--font-mono)' }}
          />
          <button type="button" className="btn-accent sm" onClick={commitOp}>OK</button>
          <button type="button" className="btn-ghost sm" onClick={() => setOp(null)}>Cancel</button>
        </div>
      )}

      {/* Upload progress */}
      {uploadProgress && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 12px', background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--line)' }}>
          <span style={{ fontSize: 12, color: 'var(--text-2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Uploading <b>{uploadProgress.name}</b>…
          </span>
          <div style={{ width: 120, height: 8, background: 'var(--line)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${uploadProgress.pct}%`, height: '100%', background: 'var(--accent)' }} />
          </div>
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>{uploadProgress.pct}%</span>
        </div>
      )}

      {/* Workspace container */}
      <div style={{ display: 'flex', gap: 12, flex: 1 }}>
        {/* Sidebar */}
        {showSidebar && (
          <aside style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--line)', paddingRight: 12, overflowY: 'auto', overflowX: 'hidden', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Favorites */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, paddingLeft: 6 }}>
                Favorites
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {favorites.map(fav => (
                  <div
                    key={fav.path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      background: currentPath === fav.path ? 'var(--hover)' : 'transparent',
                      borderRadius: 4,
                      padding: '2px 4px',
                      justifyContent: 'space-between',
                      gap: 4
                    }}
                  >
                    <button
                      type="button"
                      className="btn-ghost sm"
                      onClick={() => fetchDir(fav.path)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flex: 1,
                        justifyContent: 'flex-start',
                        color: currentPath === fav.path ? 'var(--accent)' : 'inherit',
                        padding: '4px 6px',
                        fontSize: 12,
                        border: 0,
                        textAlign: 'left',
                        cursor: 'pointer',
                        background: 'transparent',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                      title={fav.path}
                    >
                      <span>{fav.icon}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fav.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        saveFavorites(favorites.filter(f => f.path !== fav.path));
                        window.UI.toast({ kind: 'ok', title: 'Unpinned', body: `Removed "${fav.name}" from favorites.` });
                      }}
                      style={{
                        background: 'none',
                        border: 0,
                        cursor: 'pointer',
                        color: 'var(--text-3)',
                        fontSize: 10,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '4px',
                        opacity: 0.6
                      }}
                      onMouseEnter={e => e.currentTarget.style.opacity = 1}
                      onMouseLeave={e => e.currentTarget.style.opacity = 0.6}
                      title="Remove from favorites"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {favorites.length === 0 && (
                  <div className="muted" style={{ paddingLeft: 6, fontSize: 11, fontStyle: 'italic' }}>No pinned folders</div>
                )}
              </div>
            </div>

            {/* Tree */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, paddingLeft: 6 }}>
                Directory Tree
              </div>
              <DynamicFileNode name="/" path="/" activePath={currentPath} onNavigate={p => fetchDir(p)} depth={0} />
            </div>
          </aside>
        )}

        {/* Main Content Pane */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, gap: 8 }}>
          {viewFile ? (
            <FileViewer
              file={viewFile}
              loading={viewLoading}
              onClose={() => setViewFile(null)}
              onDelete={() => deleteItem(viewFile)}
              onSaved={(content) => setViewFile(p => ({ ...p, content }))}
            />
          ) : (
            <>
              {/* Action bar — only show if item is selected */}
              <div style={{ height: 38, display: 'flex', gap: 6, alignItems: 'center', padding: '0 10px',
                background: 'var(--bg-2)', borderRadius: 6,
                border: selectedItem ? '1px solid var(--line)' : '1px solid transparent',
                visibility: selectedItem ? 'visible' : 'hidden' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedItem && <>{selectedItem.isDir ? '📁' : fileIcon(selectedItem.name)} {selectedItem.name}{selectedItem?.isDir ? '/' : ''}</>}
                </span>
                {selectedItem && !selectedItem.isDir && <button type="button" className="btn-ghost sm" onClick={() => openFile(selectedItem)}>View</button>}
                {selectedItem && !selectedItem.isDir && (
                  <button type="button" className="btn-ghost sm" onClick={() => window.open(`/api/files/download?path=${encodeURIComponent(selectedItem.path)}`)}>
                    Download
                  </button>
                )}
                {selectedItem && <button type="button" className="btn-ghost sm" onClick={() => setOp({ type: 'rename', item: selectedItem, value: selectedItem.name })}>Rename</button>}
                {selectedItem && <button type="button" className="btn-ghost sm" onClick={() => {
                  const dir = currentPath.replace(/\/$/, '');
                  const baseName = selectedItem.name;
                  const di = baseName.lastIndexOf('.');
                  const copyName = di > 0 && !selectedItem.isDir ? baseName.slice(0, di) + '_copy' + baseName.slice(di) : baseName + '_copy';
                  setOp({ type: 'copy', item: selectedItem, value: dir + '/' + copyName });
                }}>Copy</button>}
                {selectedItem && <button type="button" className="btn-ghost sm" onClick={() => setOp({ type: 'move', item: selectedItem, value: selectedItem.path })}>Move</button>}
                {selectedItem && <button type="button" className="btn-ghost sm" onClick={() => {
                  const mode = prompt(`Permissions for "${selectedItem?.name}" (octal):`, '0755');
                  if (!mode) return;
                  axios.post('/api/samba/permissions', { path: selectedItem.path, mode })
                    .then(() => window.UI.toast({ kind: 'ok', title: 'Permissions updated', body: selectedItem.name }))
                    .catch(e => window.UI.toast({ kind: 'err', title: 'Failed', body: e.response?.data?.error || e.message }));
                }}>Perms</button>}
                {selectedItem && <button type="button" className="btn-ghost sm" style={{ color: 'var(--err)' }} onClick={() => deleteItem(selectedItem)}>Delete</button>}
              </div>

              {/* File list pane */}
              {viewMode === 'list' ? (
                /* List View */
                <div className="card" style={{ overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column' }}>
                  {/* Header */}
                  <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--line)',
                    color: 'var(--text-3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', userSelect: 'none', flexShrink: 0 }}>
                    <div style={{ width: 22, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }} onClick={() => { setSortBy('name'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>
                      Name {sortBy === 'name' && (sortOrder === 'asc' ? '▴' : '▾')}
                    </div>
                    <div style={{ width: 78, flexShrink: 0, textAlign: 'right', paddingRight: 8, cursor: 'pointer' }} onClick={() => { setSortBy('size'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>
                      Size {sortBy === 'size' && (sortOrder === 'asc' ? '▴' : '▾')}
                    </div>
                    <div style={{ width: 78, flexShrink: 0, paddingLeft: 8 }}>Owner</div>
                    <div style={{ width: 88, flexShrink: 0, paddingLeft: 8 }}>Mode</div>
                    <div style={{ width: 118, flexShrink: 0, paddingLeft: 8, cursor: 'pointer' }} onClick={() => { setSortBy('mtime'); setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc'); }}>
                      Modified {sortBy === 'mtime' && (sortOrder === 'asc' ? '▴' : '▾')}
                    </div>
                  </div>

                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    {loading && <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>}

                    {!loading && filteredFolders.map(f => (
                      <div key={f.name}
                        className="file-row"
                        onClick={() => handleRowClick(f, true)}
                        style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', cursor: 'pointer', gap: 0,
                          background: selected === f.name ? 'var(--accent-soft)' : 'transparent',
                          borderBottom: '1px solid var(--line-2)' }}>
                        <div style={{ width: 22, flexShrink: 0, color: 'var(--accent)', fontSize: 14 }}>📁</div>
                        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          color: 'var(--accent)', fontWeight: 500 }}>{f.name}/</div>
                        <div style={{ width: 78, flexShrink: 0, textAlign: 'right', paddingRight: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>—</div>
                        <div style={{ width: 78, flexShrink: 0, paddingLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.owner}</div>
                        <div style={{ width: 88, flexShrink: 0, paddingLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{f.perm}</div>
                        <div style={{ width: 118, flexShrink: 0, paddingLeft: 8, fontSize: 11, color: 'var(--text-3)' }}>{f.mtime}</div>
                      </div>
                    ))}

                    {!loading && filteredFiles.map(f => (
                      <div key={f.name}
                        className="file-row"
                        onClick={() => handleRowClick(f, false)}
                        style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', cursor: 'pointer', gap: 0,
                          background: selected === f.name ? 'var(--accent-soft)' : 'transparent',
                          borderBottom: '1px solid var(--line-2)' }}>
                        <div style={{ width: 22, flexShrink: 0, color: fileColor(f.name), fontSize: 14 }}>{fileIcon(f.name)}</div>
                        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                        <div style={{ width: 78, flexShrink: 0, textAlign: 'right', paddingRight: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{f.size}</div>
                        <div style={{ width: 78, flexShrink: 0, paddingLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.owner}</div>
                        <div style={{ width: 88, flexShrink: 0, paddingLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{f.perm}</div>
                        <div style={{ width: 118, flexShrink: 0, paddingLeft: 8, fontSize: 11, color: 'var(--text-3)' }}>{f.mtime}</div>
                      </div>
                    ))}

                    {!loading && filteredFolders.length === 0 && filteredFiles.length === 0 && (
                      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>No items found</div>
                    )}
                  </div>
                </div>
              ) : (
                /* Bento Grid View */
                <div className="card" style={{ overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', padding: 12 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 10, flex: 1 }}>
                    {loading && <div style={{ gridColumn: '1 / -1', padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>}

                    {!loading && filteredFolders.map(f => (
                      <div
                        key={f.name}
                        onClick={() => handleRowClick(f, true)}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '12px 6px',
                          borderRadius: 8,
                          background: selected === f.name ? 'var(--accent-soft)' : 'var(--bg-2)',
                          border: selected === f.name ? '1px solid var(--accent)' : '1px solid var(--line)',
                          cursor: 'pointer',
                          textAlign: 'center',
                          transition: 'transform 0.15s ease, border-color 0.15s ease',
                          gap: 6,
                          minHeight: 100,
                          boxSizing: 'border-box'
                        }}
                        onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.03)'}
                        onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                      >
                        <div style={{ fontSize: 28 }}>📁</div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', width: '100%', wordBreak: 'break-all' }}>{f.name}</div>
                        <div style={{ fontSize: 9, color: 'var(--text-3)' }}>Dir</div>
                      </div>
                    ))}

                    {!loading && filteredFiles.map(f => (
                      <div
                        key={f.name}
                        onClick={() => handleRowClick(f, false)}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '12px 6px',
                          borderRadius: 8,
                          background: selected === f.name ? 'var(--accent-soft)' : 'var(--bg-2)',
                          border: selected === f.name ? '1px solid var(--accent)' : '1px solid var(--line)',
                          cursor: 'pointer',
                          textAlign: 'center',
                          transition: 'transform 0.15s ease, border-color 0.15s ease',
                          gap: 6,
                          minHeight: 100,
                          boxSizing: 'border-box'
                        }}
                        onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.03)'}
                        onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                      >
                        <div style={{ fontSize: 28, color: fileColor(f.name) }}>{fileIcon(f.name)}</div>
                        <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', width: '100%', wordBreak: 'break-all' }}>{f.name}</div>
                        <div style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{f.size}</div>
                      </div>
                    ))}

                    {!loading && filteredFolders.length === 0 && filteredFiles.length === 0 && (
                      <div style={{ gridColumn: '1 / -1', padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>No items found</div>
                    )}
                  </div>
                </div>
              )}

              {/* Directory Statistics Summary Bar */}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', fontSize: 11, color: 'var(--text-3)', background: 'var(--bg-2)', borderRadius: 6, border: '1px solid var(--line)', flexShrink: 0 }}>
                <div>
                  <span>Folders: <b>{statsSummary.foldersCount}</b></span>
                  <span style={{ margin: '0 8px' }}>•</span>
                  <span>Files: <b>{statsSummary.filesCount}</b></span>
                </div>
                <div>
                  <span>Total Size: <b>{statsSummary.totalSize}</b></span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
        </>
      )}
    </div>
  );
}

function DynamicFileNode({ name, path, activePath, onNavigate, depth }) {
  const [open, setOpen] = useState(false);
  const [subdirs, setSubdirs] = useState([]);
  const [loading, setLoading] = useState(false);
  const isCurrent = path === activePath;
  const isAnc = activePath !== path && activePath.startsWith(path === '/' ? '/' : path + '/');

  useEffect(() => { if (isAnc && !open) setOpen(true); }, [isAnc]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    axios.get('/api/samba/browse', { params: { path } })
      .then(r => { if (!cancelled) setSubdirs(r.data.folders || []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, path]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        className={`tnode ${isCurrent ? 'is-active' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          padding: '4px 6px',
          borderRadius: 4,
          background: isCurrent ? 'var(--accent-soft)' : 'transparent',
          color: isCurrent ? 'var(--accent)' : 'inherit',
          transition: 'background-color 0.15s ease, color 0.15s ease'
        }}
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
          style={{
            background: 'none',
            border: 0,
            cursor: 'pointer',
            color: 'var(--text-3)',
            padding: 0,
            fontSize: 8,
            width: 12,
            height: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'transform 0.15s ease'
          }}
        >
          {open ? '▼' : '▶'}
        </button>
        <span
          onClick={() => onNavigate(path)}
          style={{
            fontSize: 14,
            display: 'flex',
            alignItems: 'center',
            color: isCurrent ? 'var(--accent)' : 'var(--text-3)'
          }}
        >
          {open ? '📂' : '📁'}
        </span>
        <span
          onClick={() => onNavigate(path)}
          style={{
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            fontWeight: isCurrent ? '600' : 'normal'
          }}
        >
          {name === '/' ? '/' : name}
        </span>
      </div>
      {open && (
        <div style={{ borderLeft: '1px solid var(--line)', marginLeft: '12px', paddingLeft: '8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {loading && <div style={{ fontSize: 10, color: 'var(--text-3)', paddingLeft: '16px' }}>…</div>}
          {subdirs.map(d => (
            <DynamicFileNode key={d.path} name={d.name} path={d.path} activePath={activePath} onNavigate={onNavigate} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- SSH ----------
function SSHTab() {
  const [sub, setSub] = useState('servers');
  return (
    <div className="tab-ssh">
      <div className="subnav">
        <button className={`subnav-item ${sub === 'servers' ? 'is-active' : ''}`} onClick={() => setSub('servers')}>servers</button>
        <button className={`subnav-item ${sub === 'keys' ? 'is-active' : ''}`} onClick={() => setSub('keys')}>keys</button>
      </div>
      {sub === 'servers' && <SSHServers />}
      {sub === 'keys' && <SSHKeysPanel />}
    </div>
  );
}

function SSHServerModal({ server, onSave, onClose }) {
  const [label, setLabel] = useState(server?.label || '');
  const [host, setHost] = useState(server?.host || '');
  const [port, setPort] = useState(server?.port || 22);
  const [username, setUsername] = useState(server?.username || 'root');
  const [authType, setAuthType] = useState(server?.authType || 'password');
  const [password, setPassword] = useState(server?.password || '');
  const [privateKey, setPrivateKey] = useState(server?.privateKey || '');
  const [passphrase, setPassphrase] = useState(server?.passphrase || '');
  const [availableKeys, setAvailableKeys] = useState([]);

  useEffect(() => {
    // Fetch available keys from host
    axios.get('/api/ssh/keys')
      .then(res => {
        setAvailableKeys(res.data.keys || []);
      })
      .catch(() => {});
  }, []);

  const handleSave = () => {
    if (!label.trim() || !host.trim() || !username.trim()) {
      window.UI.toast({ kind: 'err', title: 'Missing fields', body: 'Label, Host, and User are required.' });
      return;
    }
    const payload = {
      id: server?.id || 'ssh-' + Date.now(),
      label: label.trim(),
      host: host.trim(),
      port: parseInt(port, 10) || 22,
      username: username.trim(),
      authType,
      password: authType === 'password' ? password : '',
      privateKey: authType === 'key' ? privateKey : '',
      passphrase: authType === 'key' ? passphrase : '',
      status: 'idle'
    };
    onSave(payload);
    onClose();
  };

  return (
    <Modal
      title={server ? `Edit · ${server.label}` : 'Add SSH server'}
      subtitle={server ? `${server.username}@${server.host}:${server.port}` : 'Create a saved connection profile'}
      icon={server ? '✎' : '+'}
      onClose={onClose}
      footer={<></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="form-cols">
        <FormField label="Label" span={2}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Production VPS" autoFocus className="mono" />
        </FormField>
        <FormField label="Host">
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.1.1.10" className="mono" />
        </FormField>
        <FormField label="Port">
          <input type="number" value={port} onChange={(e) => setPort(parseInt(e.target.value, 10))} className="mono" />
        </FormField>
        <FormField label="User" span={2}>
          <input value={username} onChange={(e) => setUsername(e.target.value)} className="mono" />
        </FormField>
        <FormField label="Authentication" span={2}>
          <select value={authType} onChange={(e) => setAuthType(e.target.value)} style={{ width: '100%', background: 'none', border: '1px solid var(--line)', padding: '6px', borderRadius: '4px', color: 'inherit' }}>
            <option value="password">Password</option>
            <option value="key">SSH Private Key</option>
          </select>
        </FormField>
        {authType === 'password' ? (
          <FormField label="Password" span={2}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </FormField>
        ) : (
          <>
            <FormField label="Private Key" span={2} hint="Select a key on the host or paste custom PEM key.">
              {availableKeys.length > 0 && (
                <div style={{ marginBottom: '8px' }}>
                  <select
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    style={{ width: '100%', background: 'none', border: '1px solid var(--line)', padding: '6px', borderRadius: '4px', color: 'inherit', marginBottom: '8px' }}
                  >
                    <option value="">-- Choose Key on Host --</option>
                    {availableKeys.map(k => (
                      <option key={k.id} value={k.name}>{k.name} ({k.type})</option>
                    ))}
                  </select>
                </div>
              )}
              <textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={4}
                style={{ width: '100%', fontFamily: 'monospace', background: 'none', border: '1px solid var(--line)', borderRadius: '4px', color: 'inherit' }}
              />
            </FormField>
            <FormField label="Passphrase" span={2}>
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Optional" />
            </FormField>
          </>
        )}
        <div className="modal-foot" style={{ gridColumn: 'span 2', padding: '16px 0 0', marginTop: '12px', borderTop: '1px solid var(--line-2)', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-accent">{server ? 'Save' : 'Add server'}</button>
        </div>
      </form>
    </Modal>
  );
}

function SSHServers() {
  const [servers, setServers] = useState([]);

  useEffect(() => {
    const stored = localStorage.getItem('dashboard_ssh_servers');
    if (stored) {
      let parsed = [];
      try { parsed = JSON.parse(stored) || []; } catch (e) { parsed = []; }
      setServers(parsed);
    } else {
      const mock = [
        { id: 's1', label: 'Local Server', host: '127.0.0.1', port: 22, username: 'root', authType: 'password', status: 'idle' },
      ];
      setServers(mock);
      localStorage.setItem('dashboard_ssh_servers', JSON.stringify(mock));
    }
  }, []);

  const saveServers = (list) => {
    setServers(list);
    localStorage.setItem('dashboard_ssh_servers', JSON.stringify(list));
  };

  const connect = (s) => window.SESS.launch({
    type: 'ssh',
    title: s.label,
    subtitle: `${s.username}@${s.host}`,
    glyph: '⇄',
    data: s,
  });

  const edit = (s) => {
    window.UI.modal(
      <SSHServerModal
        server={s}
        onSave={(updatedServer) => {
          if (s) {
            saveServers(servers.map(x => x.id === s.id ? updatedServer : x));
          } else {
            saveServers([...servers, updatedServer]);
          }
        }}
        onClose={() => window.UI.closeModal()}
      />
    );
  };

  const remove = async (s) => {
    const ok = await window.UI.confirm({
      title: `Remove '${s.label}'?`,
      body: 'The connection profile will be deleted. The remote host is unaffected.',
      confirmLabel: 'Remove',
      dangerous: true,
    });
    if (ok) {
      saveServers(servers.filter(x => x.id !== s.id));
      window.UI.toast({ kind: 'ok', title: 'Server removed', body: s.label });
    }
  };

  const importLocalKeys = async () => {
    try {
      const res = await axios.get('/api/ssh/keys');
      const keys = res.data.keys || [];
      if (keys.length === 0) {
        window.UI.toast({ kind: 'warn', title: 'No keys found', body: 'No public keys found in /home/ayman/.ssh/' });
        return;
      }
      const newProfiles = keys.map((k, index) => ({
        id: 'ssh-auto-' + Date.now() + '-' + index,
        label: `Local Key (${k.name})`,
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        authType: 'key',
        password: '',
        privateKey: k.name,
        passphrase: '',
        status: 'idle'
      }));
      
      const updated = [...servers];
      let added = 0;
      for (const p of newProfiles) {
        if (!updated.some(x => x.privateKey === p.privateKey)) {
          updated.push(p);
          added++;
        }
      }
      if (added > 0) {
        saveServers(updated);
        window.UI.toast({ kind: 'ok', title: 'Keys imported', body: `Imported ${added} new SSH profile(s).` });
      } else {
        window.UI.toast({ kind: 'info', title: 'Already imported', body: 'All local keys are already in the servers list.' });
      }
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Import failed', body: e.message });
    }
  };

  return (
    <>
      <div className="ssh-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <h2>SSH servers</h2>
          <p className="muted">Saved SSH connections · click a card to open a fullscreen session.</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" className="btn-ghost" onClick={importLocalKeys}>↻ Import Local Keys</button>
          <button type="button" className="btn-accent" onClick={() => edit(null)}>+ Add server</button>
        </div>
      </div>
      <div className="ssh-grid">
        {servers.map(s => (
          <div key={s.id} className="ssh-card">
            <button type="button" className="ssh-card-main" onClick={() => connect(s)}>
              <div className="ssh-head-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="ssh-glyph mono">⇄</div>
                <StatusDot status={s.status} />
              </div>
              <div className="ssh-name" style={{ fontWeight: 'bold', fontSize: '13px', margin: '4px 0' }}>{s.label}</div>
              <div className="ssh-dest mono" style={{ fontSize: '11px', color: 'var(--text-3)' }}>{s.username}@{s.host}:{s.port}</div>
              <div className="ssh-auth muted mono" style={{ fontSize: '10px' }}>auth: {s.authType}</div>
            </button>
            <div className="ssh-actions" style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button type="button" className="btn-ghost sm" onClick={() => connect(s)}>Connect ▶</button>
              <button type="button" className="btn-ghost sm" onClick={() => edit(s)}>Edit</button>
              <button type="button" className="btn-ghost sm danger" onClick={() => remove(s)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Processes ───────────────────────────────────────────────────────────────
function ProcessesTab() {
  const [procs, setProcs] = useState([]);
  const [sort, setSort] = useState('cpu');
  const [q, setQ] = useState('');

  const load = async () => {
    try {
      const res = await axios.get(`/api/processes?sort=${sort}`);
      setProcs(res.data.processes || []);
    } catch (e) {}
  };

  useEffect(() => { load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, [sort]);

  const sendSignal = async (p, signal) => {
    const label = signal === 'SIGKILL' ? 'Force kill' : 'Terminate';
    const ok = await window.UI.confirm({
      title: `${label} PID ${p.pid}?`,
      body: `Send ${signal} to "${(p.cmd || '').slice(0, 60)}"`,
      confirmLabel: label,
      dangerous: true,
    });
    if (!ok) return;
    try {
      await axios.post(`/api/processes/${p.pid}/signal`, { signal });
      window.UI.toast({ kind: 'ok', title: `${label} sent`, body: `PID ${p.pid}` });
      load();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed', body: e.response?.data?.error || e.message });
    }
  };

  const renice = async (p) => {
    const niceStr = prompt(`Nice value for PID ${p.pid} (−20 = highest priority, 19 = lowest):`, '10');
    if (niceStr === null) return;
    const nice = parseInt(niceStr, 10);
    if (isNaN(nice) || nice < -20 || nice > 19) {
      window.UI.toast({ kind: 'err', title: 'Invalid nice value', body: 'Must be −20 to 19' });
      return;
    }
    try {
      await axios.post(`/api/processes/${p.pid}/nice`, { nice });
      window.UI.toast({ kind: 'ok', title: 'Reniced', body: `PID ${p.pid} → nice ${nice}` });
      load();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed', body: e.response?.data?.error || e.message });
    }
  };

  const filtered = useMemo(() => {
    if (!q) return procs;
    const lq = q.toLowerCase();
    return procs.filter(p => (p.cmd || '').toLowerCase().includes(lq) || String(p.pid).includes(q) || (p.user || '').toLowerCase().includes(lq));
  }, [procs, q]);

  return (
    <div className="tab-processes">
      <div className="services-toolbar">
        <div className="search">
          <span className="search-icon">⌕</span>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by name, PID, or user…" />
        </div>
        <div className="filter-chips">
          <Chip active={sort === 'cpu'} onClick={() => setSort('cpu')}>Sort CPU</Chip>
          <Chip active={sort === 'mem'} onClick={() => setSort('mem')}>Sort MEM</Chip>
        </div>
        <button className="btn-ghost" onClick={load}>↻ Refresh</button>
      </div>
      <div className="card" style={{ overflow: 'auto' }}>
        <table className="proc-table mono" style={{ width: '100%', fontSize: '12px', tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={{ width: '58px' }}>PID</th>
              <th style={{ width: '80px' }}>User</th>
              <th style={{ width: '58px' }}>CPU%</th>
              <th style={{ width: '58px' }}>MEM%</th>
              <th style={{ width: '52px' }}>Stat</th>
              <th>Command</th>
              <th style={{ width: '100px', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => (
              <tr key={p.pid}>
                <td>{p.pid}</td>
                <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.user}</td>
                <td style={{ color: p.cpu > 50 ? 'var(--err)' : p.cpu > 20 ? 'var(--warn)' : 'inherit' }}>{p.cpu.toFixed(1)}%</td>
                <td>{p.mem.toFixed(1)}%</td>
                <td>
                  <span style={{ padding: '1px 4px', borderRadius: '3px', fontSize: '10px', background: 'var(--surface-2)', border: '1px solid var(--line)' }}>{p.stat}</span>
                </td>
                <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-2)' }} title={p.cmd}>{p.cmd}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="icon-btn" title="Renice" onClick={() => renice(p)}>⚖</button>
                  <button className="icon-btn" title="SIGTERM" onClick={() => sendSignal(p, 'SIGTERM')}>■</button>
                  <button className="icon-btn" title="SIGKILL (force)" onClick={() => sendSignal(p, 'SIGKILL')} style={{ color: 'var(--err)' }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty muted" style={{ padding: 24 }}>No processes match</div>}
      </div>
    </div>
  );
}

// ─── Systemd Units ────────────────────────────────────────────────────────────
function SystemdTab() {
  const [units, setUnits] = useState([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [logUnit, setLogUnit] = useState(null);
  const [logs, setLogs] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);

  const load = () => {
    axios.get('/api/systemd/units').then(r => setUnits(r.data.units || [])).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const control = async (unit, action) => {
    const ok = await window.UI.confirm({
      title: `${action} ${unit}?`,
      confirmLabel: action.charAt(0).toUpperCase() + action.slice(1),
      dangerous: ['stop', 'disable'].includes(action),
    });
    if (!ok) return;
    try {
      await axios.post('/api/systemd/control', { unit, action });
      window.UI.toast({ kind: 'ok', title: `${action}`, body: unit });
      load();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed', body: e.response?.data?.error || e.message });
    }
  };

  const viewLogs = async (unit) => {
    setLogUnit(unit);
    setLogsLoading(true);
    try {
      const r = await axios.get(`/api/systemd/logs/${encodeURIComponent(unit)}`);
      setLogs(r.data.logs || '');
    } catch (e) {
      setLogs(`Error: ${e.message}`);
    }
    setLogsLoading(false);
  };

  const filtered = useMemo(() => {
    let list = units;
    if (filter === 'running') list = list.filter(u => u.active === 'active');
    else if (filter === 'stopped') list = list.filter(u => u.active === 'inactive');
    else if (filter === 'failed') list = list.filter(u => u.failed);
    if (q) list = list.filter(u => u.unit.toLowerCase().includes(q.toLowerCase()) || u.description.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [units, filter, q]);

  const failedCount = units.filter(u => u.failed).length;

  if (logUnit) {
    return (
      <div className="tab-systemd">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <button className="btn-ghost" onClick={() => { setLogUnit(null); setLogs(''); }}>← Back</button>
          <span className="mono" style={{ fontWeight: 'bold' }}>{logUnit}</span>
          <button className="btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => viewLogs(logUnit)}>↻ Reload</button>
        </div>
        <div className="card" style={{ fontFamily: 'monospace', fontSize: '11px', whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: '70vh', padding: '12px', lineHeight: 1.6 }}>
          {logsLoading ? 'Loading…' : (logs || 'No log entries.')}
        </div>
      </div>
    );
  }

  return (
    <div className="tab-systemd">
      <div className="services-toolbar">
        <div className="search">
          <span className="search-icon">⌕</span>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter units…" />
        </div>
        <div className="filter-chips">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All <span className="mono">{units.length}</span></Chip>
          <Chip active={filter === 'running'} onClick={() => setFilter('running')}>Active</Chip>
          <Chip active={filter === 'stopped'} onClick={() => setFilter('stopped')}>Inactive</Chip>
          {failedCount > 0 && <Chip active={filter === 'failed'} onClick={() => setFilter('failed')}>Failed <span className="mono">{failedCount}</span></Chip>}
        </div>
        <button className="btn-ghost" onClick={load}>↻ Refresh</button>
      </div>
      <div className="card" style={{ overflow: 'auto' }}>
        <table className="proc-table mono" style={{ width: '100%', fontSize: '12px' }}>
          <thead>
            <tr>
              <th>Unit</th>
              <th style={{ width: '70px' }}>Active</th>
              <th style={{ width: '80px' }}>Sub</th>
              <th>Description</th>
              <th style={{ width: '200px', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(u => (
              <tr key={u.unit}>
                <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '220px' }} title={u.unit}>
                  {u.failed && <span style={{ color: 'var(--err)', marginRight: '4px' }}>●</span>}
                  {u.unit}
                </td>
                <td style={{ color: u.active === 'active' ? 'var(--ok)' : u.active === 'failed' ? 'var(--err)' : 'var(--text-3)' }}>{u.active}</td>
                <td className="muted">{u.sub}</td>
                <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{u.description}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="icon-btn" title="View logs" onClick={() => viewLogs(u.unit)}>≡</button>
                  {u.active !== 'active'
                    ? <button className="icon-btn" title="Start" onClick={() => control(u.unit, 'start')} style={{ color: 'var(--ok)' }}>▶</button>
                    : <button className="icon-btn" title="Stop" onClick={() => control(u.unit, 'stop')} style={{ color: 'var(--warn)' }}>■</button>
                  }
                  <button className="icon-btn" title="Restart" onClick={() => control(u.unit, 'restart')}>↻</button>
                  <button className="icon-btn" title="Enable" onClick={() => control(u.unit, 'enable')}>⊕</button>
                  <button className="icon-btn" title="Disable" onClick={() => control(u.unit, 'disable')} style={{ color: 'var(--text-3)' }}>⊖</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty muted" style={{ padding: 24 }}>No units match</div>}
      </div>
    </div>
  );
}

// ─── Logs Viewer ──────────────────────────────────────────────────────────────
const LOG_PRIORITIES = [
  { value: '', label: 'All levels' },
  { value: 'err', label: 'Error+' },
  { value: 'warning', label: 'Warning+' },
  { value: 'info', label: 'Info+' },
];
const LOG_PRI_COLOR = ['var(--err)', 'var(--err)', 'var(--err)', 'var(--err)', 'var(--warn)', 'var(--warn)', 'var(--text-3)', 'var(--text-3)'];
const LOG_PRI_LABEL = ['EMERG', 'ALERT', 'CRIT', 'ERR', 'WARN', 'NOTICE', 'INFO', 'DEBUG'];

function LogsTab() {
  const [logUnits, setLogUnits] = useState([]);
  const [unit, setUnit] = useState('');
  const [priority, setPriority] = useState('');
  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState([]);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const esRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => {
    axios.get('/api/logs/units').then(r => setLogUnits(r.data.units || [])).catch(() => {});
  }, []);

  const fetch = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ n: '300' });
      if (unit) params.set('unit', unit);
      if (priority) params.set('priority', priority);
      if (search) params.set('search', search);
      const r = await axios.get(`/api/logs/query?${params}`);
      setEntries(r.data.entries || []);
    } catch (e) {}
    setLoading(false);
  };

  useEffect(() => { fetch(); }, [unit, priority]);

  useEffect(() => {
    if (!live) { esRef.current?.close(); esRef.current = null; return; }
    const params = unit ? `?unit=${encodeURIComponent(unit)}` : '';
    const es = new EventSource(`/api/logs/stream${params}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const entry = JSON.parse(ev.data);
        setEntries(prev => [...prev.slice(-600), entry]);
      } catch {}
    };
    return () => { es.close(); esRef.current = null; };
  }, [live, unit]);

  useEffect(() => { if (live) endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [entries, live]);

  const filtered = useMemo(() => {
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(e => e.msg.toLowerCase().includes(q));
  }, [entries, search]);

  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  };

  return (
    <div className="tab-logs">
      <div className="services-toolbar" style={{ flexWrap: 'wrap', gap: '8px' }}>
        <select value={unit} onChange={e => setUnit(e.target.value)} style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', padding: '6px 10px', borderRadius: '6px', color: 'inherit', minWidth: '200px' }}>
          <option value="">All units</option>
          {logUnits.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <select value={priority} onChange={e => setPriority(e.target.value)} style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', padding: '6px 10px', borderRadius: '6px', color: 'inherit' }}>
          {LOG_PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <div className="search" style={{ flex: 1, minWidth: '180px' }}>
          <span className="search-icon">⌕</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search messages… (Enter)" onKeyDown={e => e.key === 'Enter' && fetch()} />
        </div>
        <button className="btn-ghost" onClick={fetch}>↻ Fetch</button>
        <Chip active={live} onClick={() => setLive(l => !l)}>{live ? '● Live' : 'Live tail'}</Chip>
      </div>
      <div className="card" style={{ overflow: 'auto', maxHeight: '70vh' }}>
        {loading && <div className="muted" style={{ padding: '12px 16px', fontSize: '12px' }}>Loading…</div>}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: '11px' }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
              {['Time', 'Level', 'Unit', 'Message'].map((h, i) => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid var(--line)', color: 'var(--text-3)', fontWeight: 500, width: i === 0 ? 90 : i === 1 ? 55 : i === 2 ? 160 : undefined }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((e, i) => (
              <tr key={e.cursor || (e.ts + '-' + i)} style={{ borderBottom: '1px solid var(--line-2)' }}>
                <td style={{ padding: '3px 8px', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{fmtTime(e.ts)}</td>
                <td style={{ padding: '3px 8px', color: LOG_PRI_COLOR[e.priority] ?? 'var(--text-3)', fontWeight: e.priority < 4 ? 'bold' : 'normal' }}>{LOG_PRI_LABEL[e.priority] ?? '?'}</td>
                <td style={{ padding: '3px 8px', color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }} title={e.unit}>{e.unit}</td>
                <td style={{ padding: '3px 8px', wordBreak: 'break-all' }}>{e.msg}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 && <div className="empty muted" style={{ padding: 24 }}>No log entries</div>}
        <div ref={endRef} />
      </div>
      <div className="mono muted" style={{ fontSize: '10px', marginTop: '6px' }}>{filtered.length} entries{live ? ' · live tail active' : ''}</div>
    </div>
  );
}

// ─── Network ──────────────────────────────────────────────────────────────────
function NetworkTab() {
  const [sub, setSub] = useState('connections');
  const [conns, setConns] = useState([]);
  const [firewall, setFirewall] = useState(null);
  const [ifaces, setIfaces] = useState([]);

  const loadConns = () => axios.get('/api/network/connections').then(r => setConns(r.data.connections || [])).catch(() => {});
  const loadFirewall = () => { if (firewall) return; axios.get('/api/network/firewall').then(r => setFirewall(r.data)).catch(() => {}); };
  const loadIfaces = () => axios.get('/api/network/interfaces').then(r => setIfaces(r.data.interfaces || [])).catch(() => {});

  useEffect(() => { loadConns(); const id = setInterval(loadConns, 5000); return () => clearInterval(id); }, []);
  useEffect(() => { if (sub === 'firewall') loadFirewall(); if (sub === 'interfaces') loadIfaces(); }, [sub]);

  const fmtBytes = (b) => {
    if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b > 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  };

  return (
    <div className="tab-network">
      <div className="subnav">
        {['connections', 'firewall', 'interfaces', 'speedtest'].map(s => (
          <button key={s} className={`subnav-item ${sub === s ? 'is-active' : ''}`} onClick={() => setSub(s)}>{s}</button>
        ))}
      </div>

      {sub === 'connections' && (
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="proc-table mono" style={{ width: '100%', fontSize: '12px' }}>
            <thead><tr>
              <th style={{ width: '60px' }}>Proto</th>
              <th style={{ width: '80px' }}>State</th>
              <th>Local</th>
              <th>Remote</th>
              <th>Process</th>
              <th style={{ width: '55px' }}>PID</th>
            </tr></thead>
            <tbody>
              {conns.map((c, i) => (
                <tr key={i}>
                  <td><span style={{ padding: '1px 5px', borderRadius: '3px', fontSize: '10px', background: c.proto.startsWith('tcp') ? 'oklch(0.28 0.06 220)' : 'oklch(0.28 0.06 150)', color: c.proto.startsWith('tcp') ? 'oklch(0.78 0.1 220)' : 'oklch(0.78 0.1 150)' }}>{c.proto.toUpperCase()}</span></td>
                  <td style={{ color: c.state === 'LISTEN' ? 'var(--ok)' : 'var(--text-3)' }}>{c.state}</td>
                  <td style={{ fontSize: '11px' }}>{c.local}</td>
                  <td style={{ fontSize: '11px', color: 'var(--text-3)' }}>{c.remote}</td>
                  <td>{c.process}</td>
                  <td className="muted">{c.pid}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {conns.length === 0 && <div className="empty muted" style={{ padding: 24 }}>No connections</div>}
        </div>
      )}

      {sub === 'firewall' && (
        <div className="card">
          {firewall ? (
            <>
              <div style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: '8px' }}>Tool: {firewall.tool}</div>
              <pre style={{ fontFamily: 'monospace', fontSize: '11px', whiteSpace: 'pre-wrap', color: 'var(--text-2)', margin: 0, lineHeight: 1.6 }}>{firewall.output || 'No output'}</pre>
            </>
          ) : (
            <div className="muted" style={{ padding: 16 }}>Loading…</div>
          )}
        </div>
      )}

      {sub === 'interfaces' && (
        <>
          <div className="card" style={{ overflow: 'auto' }}>
            <table className="proc-table mono" style={{ width: '100%', fontSize: '12px' }}>
              <thead><tr>
                <th>Interface</th>
                <th>RX Data</th>
                <th>RX Pkts</th>
                <th>RX Err</th>
                <th>TX Data</th>
                <th>TX Pkts</th>
                <th>TX Err</th>
              </tr></thead>
              <tbody>
                {ifaces.map(iface => (
                  <tr key={iface.name}>
                    <td style={{ fontWeight: 'bold' }}>{iface.name}</td>
                    <td style={{ color: 'var(--accent)' }}>{fmtBytes(iface.rxBytes)}</td>
                    <td className="muted">{iface.rxPackets.toLocaleString()}</td>
                    <td style={{ color: iface.rxErrors > 0 ? 'var(--err)' : 'var(--text-3)' }}>{iface.rxErrors}</td>
                    <td style={{ color: 'oklch(0.72 0.12 150)' }}>{fmtBytes(iface.txBytes)}</td>
                    <td className="muted">{iface.txPackets.toLocaleString()}</td>
                    <td style={{ color: iface.txErrors > 0 ? 'var(--err)' : 'var(--text-3)' }}>{iface.txErrors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ifaces.length === 0 && <div className="empty muted" style={{ padding: 24 }}>No interfaces</div>}
          </div>
          <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn-ghost" onClick={loadIfaces}>↻ Refresh</button>
          </div>
        </>
      )}

      {sub === 'speedtest' && <SpeedtestTab />}
    </div>
  );
}

function SpeedtestTab() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [stage, setStage] = useState('idle'); // idle, init, download, upload, done, err
  const [stageProgress, setStageProgress] = useState(0); // 0 to 100
  const [errorMsg, setErrorMsg] = useState(null);
  const timersRef = useRef([]);
  useEffect(() => () => { timersRef.current.forEach(clearTimeout); timersRef.current = []; }, []);

  // Live traffic stats
  const [rxHist, setRxHist] = useState(() => Array.from({ length: 30 }, () => 0));
  const [txHist, setTxHist] = useState(() => Array.from({ length: 30 }, () => 0));
  const [currentRx, setCurrentRx] = useState(0);
  const [currentTx, setCurrentTx] = useState(0);

  // Poll /api/stats for real-time traffic
  useEffect(() => {
    const fetchTraffic = async () => {
      try {
        const res = await axios.get('/api/stats');
        const rx = res.data.network?.rxMbps || 0;
        const tx = res.data.network?.txMbps || 0;
        setCurrentRx(rx);
        setCurrentTx(tx);
        setRxHist(prev => [...prev.slice(1), rx]);
        setTxHist(prev => [...prev.slice(1), tx]);
      } catch (e) {}
    };

    fetchTraffic();
    const interval = setInterval(fetchTraffic, 2000);
    return () => clearInterval(interval);
  }, []);

  // Speedtest runner
  const runSpeedtest = async () => {
    setLoading(true);
    setResult(null);
    setErrorMsg(null);
    setStage('init');
    setStageProgress(10);

    // Simulate progress stages
    const timer1 = setTimeout(() => { setStage('download'); setStageProgress(40); }, 3000);
    const timer2 = setTimeout(() => { setStage('upload'); setStageProgress(70); }, 10000);
    const timer3 = setTimeout(() => { setStage('finish'); setStageProgress(90); }, 17000);
    timersRef.current.push(timer1, timer2, timer3);

    try {
      const res = await axios.post('/api/network/speedtest');
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
      setStageProgress(100);
      setStage('done');
      setResult(res.data);
      localStorage.setItem('last_speedtest', JSON.stringify(res.data));
    } catch (err) {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
      setStage('err');
      setErrorMsg(err.response?.data?.error || err.message || 'Speedtest failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const cached = localStorage.getItem('last_speedtest');
    if (cached) {
      try {
        setResult(JSON.parse(cached));
        setStage('done');
      } catch (e) {}
    }
  }, []);

  const stageText = {
    idle: 'Ready to run bandwidth test',
    init: 'Contacting closest Speedtest server...',
    download: 'Testing download bandwidth (this may take a few seconds)...',
    upload: 'Testing upload bandwidth (this may take a few seconds)...',
    finish: 'Wrapping up results...',
    done: 'Speedtest completed successfully',
    err: 'Speedtest failed'
  };

  return (
    <div className="speedtest-container" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {/* Console Card */}
        <div className="card bento-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 320 }}>
          <div>
            <div className="card-head" style={{ marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Bandwidth Speedtest</h3>
              <span className="muted" style={{ fontSize: 11 }}>Measure your homelab external internet speed</span>
            </div>

            {loading && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, margin: '20px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span className="mono" style={{ color: 'var(--accent)' }}>{stageText[stage]}</span>
                  <span className="mono">{stageProgress}%</span>
                </div>
                <div style={{ height: 6, background: 'var(--line)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${stageProgress}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.4s ease' }} />
                </div>
                <div className="muted" style={{ fontSize: 11, fontStyle: 'italic', textAlign: 'center' }}>
                  Please wait, executing speedtest-cli on host...
                </div>
              </div>
            )}

            {!loading && errorMsg && (
              <div style={{ padding: 12, background: 'var(--accent-soft)', border: '1px solid var(--err)', borderRadius: 6, color: 'var(--err)', fontSize: 12, margin: '12px 0' }}>
                <b>Error running speedtest:</b> {errorMsg}
              </div>
            )}

            {!loading && result && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, margin: '20px 0', textAlign: 'center' }}>
                <div style={{ padding: '12px 8px', background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--line)' }}>
                  <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Download</div>
                  <div style={{ fontSize: 20, fontWeight: 700, margin: '4px 0', color: 'var(--accent)' }}>
                    {(result.download / 1e6).toFixed(1)}
                  </div>
                  <div className="muted" style={{ fontSize: 9 }}>Mbps</div>
                </div>
                <div style={{ padding: '12px 8px', background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--line)' }}>
                  <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Upload</div>
                  <div style={{ fontSize: 20, fontWeight: 700, margin: '4px 0', color: 'oklch(0.72 0.12 150)' }}>
                    {(result.upload / 1e6).toFixed(1)}
                  </div>
                  <div className="muted" style={{ fontSize: 9 }}>Mbps</div>
                </div>
                <div style={{ padding: '12px 8px', background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--line)' }}>
                  <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ping</div>
                  <div style={{ fontSize: 20, fontWeight: 700, margin: '4px 0', color: 'var(--accent2)' }}>
                    {result.ping?.toFixed(1) || '-'}
                  </div>
                  <div className="muted" style={{ fontSize: 9 }}>ms</div>
                </div>
              </div>
            )}

            {!loading && !result && !errorMsg && (
              <div className="muted" style={{ textAlign: 'center', padding: '30px 0', fontSize: 12 }}>
                No speedtest data available. Click below to run a test.
              </div>
            )}

            {!loading && result && (
              <div style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 6, padding: 10, background: 'var(--bg-2)', borderRadius: 6, border: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="muted">Server:</span>
                  <span style={{ fontWeight: 500 }}>{result.server?.sponsor} ({result.server?.name})</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="muted">ISP / IP:</span>
                  <span className="mono">{result.client?.isp} ({result.client?.ip})</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="muted">Time:</span>
                  <span>{new Date(result.timestamp).toLocaleString()}</span>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            className="btn-accent"
            disabled={loading}
            onClick={runSpeedtest}
            style={{ width: '100%', padding: '10px', height: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 12 }}
          >
            {loading ? (
              <>
                <span className="spinner" style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                Running Test...
              </>
            ) : (
              'Run Speedtest'
            )}
          </button>
        </div>

        {/* Traffic Card */}
        <div className="card bento-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', minHeight: 320 }}>
          <div className="card-head" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Real-time Traffic Analyzer</h3>
            <span className="muted" style={{ fontSize: 11 }}>Live outbound (TX) and inbound (RX) network throughput</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, justifyContent: 'center' }}>
            {/* RX */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: 10, background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--line)' }}>
              <div style={{ flex: 1 }}>
                <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Inbound (RX)</div>
                <div style={{ fontSize: 22, fontWeight: 700, margin: '2px 0', color: 'var(--accent)' }}>
                  {currentRx.toFixed(1)} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-2)' }}>Mbps</span>
                </div>
              </div>
              <div style={{ background: 'var(--bg)', padding: 4, borderRadius: 4, border: '1px solid var(--line-2)' }}>
                <Sparkline data={rxHist} width={180} height={40} stroke="var(--accent)" fill="var(--accent)" />
              </div>
            </div>

            {/* TX */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: 10, background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--line)' }}>
              <div style={{ flex: 1 }}>
                <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Outbound (TX)</div>
                <div style={{ fontSize: 22, fontWeight: 700, margin: '2px 0', color: 'oklch(0.72 0.12 150)' }}>
                  {currentTx.toFixed(1)} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-2)' }}>Mbps</span>
                </div>
              </div>
              <div style={{ background: 'var(--bg)', padding: 4, borderRadius: 4, border: '1px solid var(--line-2)' }}>
                <Sparkline data={txHist} width={180} height={40} stroke="oklch(0.72 0.12 150)" fill="oklch(0.72 0.12 150)" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Cron Manager ─────────────────────────────────────────────────────────────
const CRON_PRESETS = [
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily midnight', value: '0 0 * * *' },
  { label: 'Daily noon', value: '0 12 * * *' },
  { label: 'Weekly Sun', value: '0 0 * * 0' },
  { label: 'Monthly 1st', value: '0 0 1 * *' },
];

function CronTab() {
  const [entries, setEntries] = useState([]);
  const [timers, setTimers] = useState([]);
  const [sub, setSub] = useState('crontab');
  const [adding, setAdding] = useState(false);
  const [newSchedule, setNewSchedule] = useState('0 * * * *');
  const [newCommand, setNewCommand] = useState('');
  const [newUser, setNewUser] = useState('user');
  const [runningJob, setRunningJob] = useState(null);
  const [runOutput, setRunOutput] = useState('');
  const [runLoading, setRunLoading] = useState(false);

  const load = () => {
    axios.get('/api/cron').then(r => { setEntries(r.data.entries || []); setTimers(r.data.timers || []); }).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const addEntry = async () => {
    if (!newSchedule.trim() || !newCommand.trim()) {
      window.UI.toast({ kind: 'err', title: 'Missing fields', body: 'Schedule and command are required.' });
      return;
    }
    try {
      await axios.post('/api/cron', { schedule: newSchedule, command: newCommand, user: newUser });
      window.UI.toast({ kind: 'ok', title: 'Cron entry added' });
      setAdding(false); setNewCommand('');
      load();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed', body: e.response?.data?.error || e.message });
    }
  };

  const deleteEntry = async (entry) => {
    const ok = await window.UI.confirm({ title: 'Delete cron entry?', body: `${entry.schedule} ${entry.command}`, confirmLabel: 'Delete', dangerous: true });
    if (!ok) return;
    try {
      await axios.delete(`/api/cron/${entry.id}?user=${entry.owner}`);
      window.UI.toast({ kind: 'ok', title: 'Entry deleted' });
      load();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed', body: e.response?.data?.error || e.message });
    }
  };

  const toggleEntry = async (entry) => {
    try {
      await axios.post('/api/cron/toggle', { id: entry.id, active: !entry.active, user: entry.owner });
      window.UI.toast({ kind: 'ok', title: entry.active ? 'Cron disabled' : 'Cron enabled', body: entry.command });
      load();
    } catch (e) {
      window.UI.toast({ kind: 'err', title: 'Failed to toggle', body: e.response?.data?.error || e.message });
    }
  };

  const runEntry = async (entry) => {
    setRunningJob(entry);
    setRunLoading(true);
    setRunOutput('Executing command in background...');
    try {
      const res = await axios.post('/api/cron/run', { command: entry.command, user: entry.owner });
      setRunOutput(res.data.output || 'Command completed with no output.');
    } catch (e) {
      setRunOutput(`Execution failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setRunLoading(false);
    }
  };

  return (
    <div className="tab-cron">
      <div className="subnav">
        <button className={`subnav-item ${sub === 'crontab' ? 'is-active' : ''}`} onClick={() => setSub('crontab')}>Crontab <span className="mono" style={{ fontSize: '10px' }}>{entries.length}</span></button>
        <button className={`subnav-item ${sub === 'timers' ? 'is-active' : ''}`} onClick={() => setSub('timers')}>Systemd Timers <span className="mono" style={{ fontSize: '10px' }}>{timers.length}</span></button>
      </div>

      {sub === 'crontab' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <span className="muted" style={{ fontSize: '13px' }}>{entries.length} scheduled job{entries.length !== 1 ? 's' : ''}</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-ghost" onClick={load}>↻ Reload</button>
              <button className="btn-accent" onClick={() => setAdding(a => !a)}>{adding ? 'Cancel' : '+ Add entry'}</button>
            </div>
          </div>

          {adding && (
            <div className="card" style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--text-3)', display: 'block', marginBottom: '4px' }}>Schedule (cron expression)</label>
                  <input value={newSchedule} onChange={e => setNewSchedule(e.target.value)} className="mono"
                    style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--line)', padding: '6px 10px', borderRadius: '6px', color: 'inherit', boxSizing: 'border-box' }} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                    {CRON_PRESETS.map(p => (
                      <button key={p.value} className="btn-ghost" style={{ fontSize: '10px', padding: '2px 7px' }} onClick={() => setNewSchedule(p.value)}>{p.label}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--text-3)', display: 'block', marginBottom: '4px' }}>Command</label>
                  <input value={newCommand} onChange={e => setNewCommand(e.target.value)} placeholder="/path/to/script.sh" className="mono"
                    style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--line)', padding: '6px 10px', borderRadius: '6px', color: 'inherit', boxSizing: 'border-box' }} />
                  <div style={{ marginTop: '6px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-3)' }}>User:</span>
                    <select value={newUser} onChange={e => setNewUser(e.target.value)}
                      style={{ background: 'var(--bg-2)', border: '1px solid var(--line)', padding: '4px 8px', borderRadius: '4px', color: 'inherit', fontSize: '12px' }}>
                      <option value="user">Current user</option>
                      <option value="root">root</option>
                    </select>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn-accent" onClick={addEntry}>Add cron entry</button>
              </div>
            </div>
          )}

          <div className="card" style={{ overflow: 'auto' }}>
            <table className="proc-table mono" style={{ width: '100%', fontSize: '12px' }}>
              <thead><tr>
                <th style={{ width: '50px' }}>Active</th>
                <th style={{ width: '120px' }}>Schedule</th>
                <th>Command</th>
                <th style={{ width: '80px' }}>User</th>
                <th style={{ width: '140px', textAlign: 'right' }}>Actions</th>
              </tr></thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id} style={{ opacity: e.active ? 1 : 0.5 }}>
                    <td>
                      <input type="checkbox" checked={e.active} onChange={() => toggleEntry(e)} title={e.active ? "Click to disable" : "Click to enable"} />
                    </td>
                    <td style={{ color: 'var(--accent)' }}>{e.schedule}</td>
                    <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-2)' }} title={e.command}>{e.command}</td>
                    <td className="muted">{e.owner}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button className="btn-ghost sm" onClick={() => runEntry(e)} title="Run command immediately">▶ Run</button>
                        <button className="icon-btn" title="Delete" onClick={() => deleteEntry(e)} style={{ color: 'var(--err)', marginLeft: 8 }}>✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {entries.length === 0 && <div className="empty muted" style={{ padding: 24 }}>No cron entries found</div>}
          </div>
        </>
      )}

      {sub === 'timers' && (
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="proc-table mono" style={{ width: '100%', fontSize: '12px' }}>
            <thead><tr>
              <th>Timer Unit</th>
              <th>Activates</th>
              <th>Next Run</th>
              <th>Last Run</th>
            </tr></thead>
            <tbody>
              {timers.map((t, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--accent)' }}>{t.unit}</td>
                  <td className="muted">{t.activates}</td>
                  <td style={{ color: 'var(--ok)' }}>{t.next}</td>
                  <td className="muted">{t.last}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {timers.length === 0 && <div className="empty muted" style={{ padding: 24 }}>No systemd timers found</div>}
        </div>
      )}

      {runningJob && (
        <Modal title={`Running command manual execution`} onClose={() => setRunningJob(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Command: <b>{runningJob.command}</b> as user <b>{runningJob.owner}</b>
            </div>
            <pre style={{
              background: 'var(--bg-2)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: 12,
              maxHeight: 300,
              overflow: 'auto',
              fontSize: 11,
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              margin: 0
            }}>
              {runOutput}
            </pre>
            {runLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--accent)' }}>
                <span className="spinner" style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                Running...
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn-accent" onClick={() => setRunningJob(null)} disabled={runLoading}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- TEMPERATURE MONITORING ----------
function TemperaturesTab() {
  const [stats, setStats] = useState(null);
  const [smart, setSmart] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const [statsRes, smartRes] = await Promise.all([
        axios.get('/api/stats'),
        axios.get('/api/disk/smart').catch(() => ({ data: { disks: [] } }))
      ]);
      setStats(statsRes.data);
      setSmart(smartRes.data.disks || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(async () => {
      try {
        const res = await axios.get('/api/stats');
        setStats(res.data);
      } catch (e) {}
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !stats) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>Loading temperature monitors...</div>;
  }

  const temps = stats?.temps || { cpu: 0, gpu: 0, disk: 0 };

  const getTempTone = (temp) => {
    if (temp >= 80) return 'var(--err)';
    if (temp >= 65) return 'var(--warn)';
    return 'var(--ok)';
  };

  // Filter devices that actually return a temperature
  const devices = [];
  
  if (temps.cpu > 0) {
    devices.push({
      id: 'cpu',
      name: 'CPU Thermal Zone',
      type: 'Processor',
      temp: temps.cpu,
      icon: '💻'
    });
  }

  if (temps.gpu > 0) {
    devices.push({
      id: 'gpu',
      name: 'Nvidia GPU',
      type: 'Graphics Card',
      temp: temps.gpu,
      icon: '🎮'
    });
  }

  if (temps.disk > 0) {
    devices.push({
      id: 'nvme_hwmon',
      name: 'NVMe controller (hwmon)',
      type: 'Storage Controller',
      temp: temps.disk,
      icon: '💾'
    });
  }

  smart.forEach(d => {
    if (d.temperature !== null && d.temperature !== undefined && d.temperature > 0) {
      const isDuplicate = devices.some(dev => dev.name.toLowerCase().includes(d.device.toLowerCase()));
      if (!isDuplicate) {
        devices.push({
          id: `disk_${d.device}`,
          name: `Drive /dev/${d.device}`,
          type: d.model || 'Storage Drive',
          temp: d.temperature,
          icon: '💽',
          smartHealth: d.health
        });
      }
    }
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>Hardware Temperatures</h2>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Real-time temperatures for active thermal zones and physical devices.</p>
        </div>
        <button className="btn-ghost" onClick={fetchData}>↻ Refresh</button>
      </div>

      {devices.length === 0 ? (
        <div className="card empty muted" style={{ padding: 48, textAlign: 'center' }}>
          <span style={{ fontSize: 32, display: 'block', marginBottom: 12 }}>❄️</span>
          No temperature sensors detected on this system.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {devices.map(dev => {
            const tone = getTempTone(dev.temp);
            return (
              <div key={dev.id} className="card bento-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 130 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span style={{ fontSize: 24 }}>{dev.icon}</span>
                    <div>
                      <h4 style={{ margin: 0, fontSize: 13, fontWeight: 'bold' }}>{dev.name}</h4>
                      <span className="muted" style={{ fontSize: 10 }}>{dev.type}</span>
                    </div>
                  </div>
                  {dev.smartHealth && (
                    <span style={{
                      padding: '1px 5px',
                      borderRadius: '3px',
                      fontSize: '9px',
                      fontWeight: 700,
                      background: dev.smartHealth === 'PASSED' ? 'oklch(0.28 0.08 150)' : 'oklch(0.28 0.08 18)',
                      color: dev.smartHealth === 'PASSED' ? 'oklch(0.78 0.12 150)' : 'oklch(0.78 0.1 18)'
                    }}>
                      {dev.smartHealth}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                      <span className="muted">Status</span>
                      <span style={{ color: tone, fontWeight: 'bold' }}>
                        {dev.temp >= 80 ? 'Critical' : dev.temp >= 65 ? 'Warm' : 'Normal'}
                      </span>
                    </div>
                    <div style={{ height: 6, background: 'var(--line)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.min(100, (dev.temp / 100) * 100)}%`,
                        height: '100%',
                        background: tone,
                        borderRadius: 3,
                        transition: 'width 0.5s ease-in-out'
                      }} />
                    </div>
                  </div>
                  
                  <div style={{ marginLeft: 16, textAlign: 'right', flexShrink: 0 }}>
                    <span style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                      {dev.temp.toFixed(0)}
                    </span>
                    <span style={{ fontSize: 14, color: 'var(--text-3)', fontWeight: 500, verticalAlign: 'super' }}>°C</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── System (combined subtab panel) ──────────────────────────────────────────
function SystemTab() {
  const [sub, setSub] = useState('processes');
  const subtabs = [
    { id: 'processes', label: 'Processes', glyph: '⊞' },
    { id: 'temps',     label: 'Temps',     glyph: '🌡' },
    { id: 'updates',   label: 'Updates',   glyph: '↥' },
    { id: 'logs',      label: 'Logs',      glyph: '≡' },
    { id: 'network',   label: 'Network',   glyph: '⇌' },
    { id: 'units',     label: 'Units',     glyph: '⚙' },
    { id: 'cron',      label: 'Cron',      glyph: '◷' },
  ];
  return (
    <div className="tab-system">
      <div className="subnav" style={{ marginBottom: 16 }}>
        {subtabs.map(t => (
          <button key={t.id} className={`subnav-item ${sub === t.id ? 'is-active' : ''}`} onClick={() => setSub(t.id)}>
            <span style={{ marginRight: 4, opacity: 0.7 }}>{t.glyph}</span>{t.label}
          </button>
        ))}
      </div>
      {sub === 'processes' && <ProcessesTab />}
      {sub === 'temps'     && <TemperaturesTab />}
      {sub === 'updates'   && <SystemUpdatesTab />}
      {sub === 'logs'      && <LogsTab />}
      {sub === 'network'   && <NetworkTab />}
      {sub === 'units'     && <SystemdTab />}
      {sub === 'cron'      && <CronTab />}
    </div>
  );
}

export {
  Overview, ServicesTab, AgentsTab, SambaTab, FilesTab, SSHTab,
  ProcessesTab, SystemdTab, LogsTab, NetworkTab, CronTab,
  SystemTab,
  Sparkline, Gauge, Bar, StatusDot, Chip, Favicon, KBD,
};
