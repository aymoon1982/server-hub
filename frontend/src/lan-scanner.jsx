import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';

const STATE_COLOR = {
  reachable: '#6dd49a',
  stale:     '#f0c75a',
  delay:     '#5cc8e2',
  probe:     '#5cc8e2',
  noarp:     'var(--text-3)',
  permanent: '#a78bfa',
};

const SERVICE_ICONS = {
  ssh: '🔐', http: '🌐', https: '🔒', 'netbios-ssn': '📁', 'microsoft-ds': '📁',
  ftp: '📂', telnet: '💻', smtp: '✉', 'ms-wbt-server': '🖥', vnc: '🖥',
  mysql: '🗄', 'ms-sql-s': '🗄', 'http-proxy': '🔄', mongodb: '🗄',
};

function PortScanPanel({ ip, onClose }) {
  const [ports, setPorts] = useState([]);
  const [status, setStatus] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    setPorts([]);
    setDone(false);
    setStatus('Starting…');

    // Abort the stream when the panel closes or the IP changes — otherwise the
    // old scan keeps running and setState fires on an unmounted component
    const controller = new AbortController();
    let aborted = false;

    fetch('/api/network/lan/portscan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip }),
      signal: controller.signal,
    }).then(res => {
      if (!res.ok || !res.body) { if (!aborted) { setStatus(`Error: HTTP ${res.status}`); setDone(true); } return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const read = () => reader.read().then(({ done: d, value }) => {
        if (aborted) return;
        if (d) { setDone(true); return; }
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop();
        for (const block of blocks) {
          const dl = block.split('\n').find(l => l.startsWith('data:'));
          if (!dl) continue;
          try {
            const msg = JSON.parse(dl.slice(5));
            if (msg.type === 'status') setStatus(msg.msg);
            if (msg.type === 'port') setPorts(p => [...p, msg]);
            if (msg.type === 'done') setDone(true);
            if (msg.type === 'error') { setStatus(`Error: ${msg.msg}`); setDone(true); }
          } catch {}
        }
        read();
      }).catch(() => { if (!aborted) setDone(true); });
      read();
    }).catch(e => { if (!aborted) { setStatus(`Error: ${e.message}`); setDone(true); } });

    return () => { aborted = true; controller.abort(); };
  }, [ip]);

  return (
    <div style={{ marginTop: 6, padding: '10px 12px', background: 'var(--surface-3)', borderRadius: 6, border: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'monospace' }}>
          {done ? `${ports.length} open port${ports.length !== 1 ? 's' : ''}` : <><span className="spinner" style={{ marginRight: 4 }} />{status}</>}
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
      </div>
      {ports.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)' }}>
              {['Port', 'Proto', 'Service', 'Version'].map(h => (
                <th key={h} style={{ padding: '3px 8px', textAlign: 'left', color: 'var(--text-3)', fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ports.map((p, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ padding: '3px 8px', fontFamily: 'monospace', color: '#6dd49a' }}>{p.port}</td>
                <td style={{ padding: '3px 8px', fontFamily: 'monospace', color: 'var(--text-3)' }}>{p.proto}</td>
                <td style={{ padding: '3px 8px' }}>{SERVICE_ICONS[p.service] || ''} {p.service}</td>
                <td style={{ padding: '3px 8px', color: 'var(--text-3)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.version || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : done ? (
        <div className="muted" style={{ fontSize: 11, padding: '4px 8px' }}>No open ports found on common services.</div>
      ) : null}
    </div>
  );
}

function LabelEditor({ mac, current, onSave, onCancel }) {
  const [val, setVal] = useState(current || '');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const submit = () => onSave(val.trim());
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <input
        ref={ref}
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
        placeholder="Device label…"
        style={{ padding: '2px 6px', background: 'var(--surface-3)', border: '1px solid var(--accent)', borderRadius: 4, fontSize: 12, color: 'var(--text-1)', outline: 'none', width: 140 }}
      />
      <button onClick={submit} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>✓</button>
      <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 13 }}>×</button>
    </div>
  );
}

function DeviceRow({ d, labels, onSaveLabel, scanning }) {
  const [showScan, setShowScan] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [wolSent, setWolSent] = useState(false);

  const label = d.mac ? labels[d.mac] : null;
  const displayName = label || d.hostname || null;

  const saveLabel = async (val) => {
    if (!d.mac) return;
    await axios.post('/api/network/lan/labels', { mac: d.mac, label: val });
    onSaveLabel(d.mac, val);
    setEditingLabel(false);
  };

  const sendWol = async () => {
    if (!d.mac) return;
    try {
      await axios.post('/api/network/lan/wol', { mac: d.mac });
      setWolSent(true);
      window.UI?.toast({ kind: 'ok', title: 'WoL sent', body: d.mac });
      setTimeout(() => setWolSent(false), 3000);
    } catch (e) {
      window.UI?.toast({ kind: 'err', title: 'WoL failed', body: e.response?.data?.error || e.message });
    }
  };

  return (
    <>
      <tr style={{ borderBottom: showScan ? 'none' : '1px solid var(--line)' }}>
        <td style={TD} className="mono">{d.ip}</td>
        <td style={TD}>
          {editingLabel ? (
            <LabelEditor mac={d.mac} current={label} onSave={saveLabel} onCancel={() => setEditingLabel(false)} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {displayName ? (
                  <span style={{ fontWeight: label ? 600 : 400, color: label ? 'var(--accent)' : 'var(--text-1)', fontSize: 13 }}>{displayName}</span>
                ) : (
                  <span className="muted" style={{ fontSize: 12 }}>—</span>
                )}
                {label && d.hostname && d.hostname !== label && (
                  <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'monospace' }}>{d.hostname}</span>
                )}
              </div>
              {d.mac && (
                <button onClick={() => setEditingLabel(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 10, textAlign: 'left', padding: 0, width: 'fit-content' }}>
                  {label ? '✎ edit label' : '+ add label'}
                </button>
              )}
            </div>
          )}
        </td>
        <td style={TD}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {d.mac ? (
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-2)' }}>{d.mac}</span>
            ) : <span className="muted">—</span>}
            {d.vendor && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{d.vendor}</span>}
          </div>
        </td>
        <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-3)' }}>
          {d.latency != null ? `${d.latency}ms` : '—'}
        </td>
        <td style={TD}>
          <span style={{ color: STATE_COLOR[d.state] || 'var(--text-3)', fontFamily: 'monospace', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3 }}>
            {d.state || '?'}
          </span>
        </td>
        <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-3)' }}>{d.iface || '—'}</td>
        <td style={TD}>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={() => setShowScan(s => !s)}
              title="Port scan"
              style={{ ...ABTN, background: showScan ? 'var(--accent)' : 'var(--surface-3)', color: showScan ? '#fff' : 'var(--text-2)', border: '1px solid var(--line)' }}
            >
              ⌕ Ports
            </button>
            {d.mac && (
              <button
                onClick={sendWol}
                disabled={wolSent}
                title="Wake on LAN"
                style={{ ...ABTN, background: 'var(--surface-3)', color: wolSent ? '#6dd49a' : 'var(--text-2)', border: '1px solid var(--line)' }}
              >
                {wolSent ? '✓ Sent' : '⚡ WoL'}
              </button>
            )}
          </div>
        </td>
      </tr>
      {showScan && (
        <tr style={{ borderBottom: '1px solid var(--line)' }}>
          <td colSpan={7} style={{ padding: '0 12px 10px 12px' }}>
            <PortScanPanel ip={d.ip} onClose={() => setShowScan(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

const SORT_KEYS = { ip: 'IP', hostname: 'Hostname', vendor: 'Vendor', latency: 'Latency', state: 'State' };

export function LANScannerTab() {
  const [devices, setDevices]     = useState([]);
  const [labels, setLabels]       = useState({});
  const [loading, setLoading]     = useState(true);
  const [scanning, setScanning]   = useState(false);
  const [scanLog, setScanLog]     = useState([]);
  const [filter, setFilter]       = useState('');
  const [subnet, setSubnet]       = useState('');
  const [sortKey, setSortKey]     = useState('ip');
  const [sortAsc, setSortAsc]     = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const timerRef = useRef(null);

  const loadARP = useCallback(() => {
    setLoading(true);
    axios.get('/api/network/lan')
      .then(r => {
        const devs = r.data.devices || [];
        setDevices(devs);
        const lbl = {};
        devs.forEach(d => { if (d.mac && d.label) lbl[d.mac] = d.label; });
        setLabels(lbl);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { loadARP(); }, [loadARP]);

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(loadARP, 30000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [autoRefresh, loadARP]);

  const startScan = () => {
    if (scanning) return;
    setScanning(true);
    setScanLog([]);
    const seen = new Set();
    const live = {};

    fetch('/api/network/lan/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subnet ? { subnet } : {}),
    }).then(res => {
      if (!res.ok || !res.body) {
        setScanLog(l => [...l, `Error: HTTP ${res.status}`]);
        setScanning(false);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const read = () => reader.read().then(({ done, value }) => {
        if (done) { setScanning(false); loadARP(); return; }
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop();
        for (const block of blocks) {
          const dl = block.split('\n').find(l => l.startsWith('data:'));
          if (!dl) continue;
          try {
            const msg = JSON.parse(dl.slice(5));
            if (msg.type === 'status') setScanLog(l => [...l, msg.msg]);
            if (msg.type === 'device') {
              seen.add(msg.ip);
              live[msg.ip] = {
                ip: msg.ip, hostname: msg.hostname || null,
                mac: msg.mac || null, vendor: msg.vendor || null,
                latency: msg.latency ?? null, state: 'reachable',
                iface: null, label: msg.label || labels[msg.mac] || null,
              };
              setDevices(Object.values(live));
            }
            if (msg.type === 'done' || msg.type === 'error') {
              if (msg.type === 'error') setScanLog(l => [...l, `Error: ${msg.msg}`]);
              setScanning(false);
              loadARP();
            }
          } catch {}
        }
        read();
      }).catch(() => { setScanning(false); loadARP(); });
      read();
    }).catch(() => setScanning(false));
  };

  const onSaveLabel = (mac, val) => {
    setLabels(prev => val ? { ...prev, [mac]: val } : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== mac)));
  };

  const sort = (key) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  const q = filter.toLowerCase();
  const filtered = devices.filter(d =>
    !q || d.ip?.includes(q) || d.hostname?.toLowerCase().includes(q) ||
    d.mac?.toLowerCase().includes(q) || d.vendor?.toLowerCase().includes(q) ||
    (d.mac && labels[d.mac]?.toLowerCase().includes(q))
  );

  const sorted = [...filtered].sort((a, b) => {
    let av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
    if (sortKey === 'ip') {
      // Zero-pad each octet so lexicographic compare matches numeric order
      av = a.ip.split('.').map(n => n.padStart(3, '0')).join('');
      bv = b.ip.split('.').map(n => n.padStart(3, '0')).join('');
    }
    if (sortKey === 'latency') { av = a.latency ?? 9999; bv = b.latency ?? 9999; }
    if (typeof av === 'number') return sortAsc ? av - bv : bv - av;
    return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });

  const SortTH = ({ k, label }) => (
    <th onClick={() => sort(k)} style={{ ...TH, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
      {label}{sortKey === k ? (sortAsc ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter by IP, hostname, MAC, vendor, label…"
          style={INPUT}
        />
        <input
          value={subnet}
          onChange={e => setSubnet(e.target.value)}
          placeholder="Subnet (e.g. 10.1.1.0/24)"
          style={{ ...INPUT, flex: '0 0 180px', fontSize: 12 }}
        />
        <button className="btn-accent" onClick={startScan} disabled={scanning}>
          {scanning ? <><span className="spinner" style={{ marginRight: 6 }} />Scanning…</> : '⌕ Scan'}
        </button>
        <button className="btn-ghost" onClick={loadARP} disabled={loading || scanning} title="Reload ARP table">
          {loading ? <span className="spinner" /> : '↻'}
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-3)', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          Auto 30s
        </label>
        <span className="mono muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{filtered.length} device{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Scan log */}
      {scanLog.length > 0 && (
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', padding: '6px 10px', background: 'var(--surface-3)', borderRadius: 6, lineHeight: 1.6 }}>
          {scanLog.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center' }} className="muted">Loading…</div>
      ) : sorted.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center' }} className="muted">
          No devices found.{filter ? ' Clear filter.' : ' Click Scan to discover hosts.'}
        </div>
      ) : (
        <div className="card lan-table-wrap" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                <SortTH k="ip" label="IP" />
                <SortTH k="hostname" label="Hostname / Label" />
                <SortTH k="vendor" label="MAC / Vendor" />
                <SortTH k="latency" label="Latency" />
                <SortTH k="state" label="State" />
                <th style={TH}>Interface</th>
                <th style={TH}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(d => (
                <DeviceRow key={d.ip} d={d} labels={labels} onSaveLabel={onSaveLabel} scanning={scanning} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="muted mono" style={{ fontSize: 11 }}>
        ARP table shows recently seen hosts · Active Scan uses nmap with MAC + vendor detection · Click ⌕ Ports to scan services
      </div>
    </div>
  );
}

const TH   = { padding: '8px 12px', textAlign: 'left', color: 'var(--text-3)', fontWeight: 500, fontSize: 11 };
const TD   = { padding: '8px 12px', verticalAlign: 'middle' };
const ABTN = { fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: 'pointer' };
const INPUT = {
  flex: 1, minWidth: 160, padding: '6px 10px',
  background: 'var(--surface-3)', border: '1px solid var(--line)',
  borderRadius: 6, fontSize: 13, color: 'var(--text-1)', outline: 'none',
};
