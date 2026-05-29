import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

function StreamLog({ lines }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  if (!lines.length) return null;
  return (
    <pre ref={ref} style={{
      background: 'var(--surface-3)',
      border: '1px solid var(--line)',
      borderRadius: 6,
      padding: 12,
      maxHeight: 280,
      overflowY: 'auto',
      fontFamily: 'monospace',
      fontSize: 11,
      color: 'var(--text-2)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      margin: 0,
    }}>
      {lines.join('')}
    </pre>
  );
}

function PkgInfoModal({ name, onClose }) {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    axios.get('/api/packages/info', { params: { name } })
      .then(r => setInfo(r.data.info))
      .catch(() => setInfo({ Error: 'Failed to load package info' }));
  }, [name]);

  const SHOW_FIELDS = ['Package', 'Version', 'Architecture', 'Installed-Size', 'Maintainer', 'Homepage', 'Depends', 'Description'];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card" style={{ width: 520, maxHeight: '72vh', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="mono" style={{ margin: 0, fontSize: 16 }}>{name}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 20, lineHeight: 1 }}>×</button>
        </div>
        {!info ? (
          <div className="muted" style={{ textAlign: 'center', padding: 20 }}>Loading…</div>
        ) : (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <tbody>
              {SHOW_FIELDS.filter(k => info[k]).map(k => (
                <tr key={k} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '7px 0', color: 'var(--text-3)', width: 130, verticalAlign: 'top', fontWeight: 500 }}>{k}</td>
                  <td style={{ padding: '7px 0', color: 'var(--text-2)', wordBreak: 'break-word' }}>{info[k]}</td>
                </tr>
              ))}
              {!Object.keys(info).length && <tr><td colSpan={2} className="muted">No data available.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function usePkgAction() {
  const [actionPkg, setActionPkg] = useState(null);
  const [logLines, setLogLines] = useState([]);

  const run = (action, pkg, onDone) => {
    setActionPkg(pkg);
    setLogLines([]);
    fetch(`/api/packages/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packages: [pkg] }),
    }).then(res => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const read = () => reader.read().then(({ done, value }) => {
        if (done) { setActionPkg(null); return; }
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop();
        for (const block of blocks) {
          const dl = block.split('\n').find(l => l.startsWith('data:'));
          if (!dl) continue;
          try {
            const msg = JSON.parse(dl.slice(5));
            if (msg.type === 'log') setLogLines(l => [...l, msg.text]);
            if (msg.type === 'done') {
              setActionPkg(null);
              const ok = msg.code === 0;
              window.UI?.toast({
                kind: ok ? 'ok' : 'err',
                title: ok ? (action === 'install' ? 'Installed' : 'Removed') : 'Failed',
                body: ok ? pkg : `Exit code ${msg.code}`,
              });
              if (ok && onDone) onDone(action, pkg);
            }
          } catch {}
        }
        read();
      }).catch(() => setActionPkg(null));
      read();
    }).catch(() => setActionPkg(null));
  };

  return { actionPkg, logLines, run };
}

export function PackagesTab() {
  const [sub, setSub]                   = useState('search');
  const [query, setQuery]               = useState('');
  const [results, setResults]           = useState([]);
  const [searching, setSearching]       = useState(false);
  const [installed, setInstalled]       = useState([]);
  const [instFilter, setInstFilter]     = useState('');
  const [instLoading, setInstLoading]   = useState(false);
  const [infoPkg, setInfoPkg]           = useState(null);
  const { actionPkg, logLines, run }    = usePkgAction();

  const doSearch = (q = query) => {
    if (!q.trim() || q.length < 2) return;
    setSearching(true);
    setResults([]);
    axios.get('/api/packages/search', { params: { q } })
      .then(r => { setResults(r.data.packages || []); setSearching(false); })
      .catch(() => setSearching(false));
  };

  const loadInstalled = (q = instFilter) => {
    setInstLoading(true);
    axios.get('/api/packages/installed', { params: q ? { q } : {} })
      .then(r => { setInstalled(r.data.packages || []); setInstLoading(false); })
      .catch(() => setInstLoading(false));
  };

  useEffect(() => { if (sub === 'installed') loadInstalled(); }, [sub]);

  const onDone = (action, pkg) => {
    setResults(prev => prev.map(p => p.name === pkg ? { ...p, installed: action === 'install' } : p));
    if (sub === 'installed') loadInstalled();
  };

  const Badge = ({ installed: inst }) => (
    <span style={{
      fontSize: 10, padding: '2px 7px', borderRadius: 10, fontFamily: 'monospace',
      background: inst ? 'rgba(109,212,154,0.12)' : 'var(--surface-3)',
      color: inst ? '#6dd49a' : 'var(--text-3)',
      border: `1px solid ${inst ? 'rgba(109,212,154,0.3)' : 'var(--line)'}`,
    }}>
      {inst ? '✓ installed' : 'available'}
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {['search', 'installed'].map(s => (
          <button key={s} className={`tab-pill ${sub === s ? 'is-active' : ''}`} onClick={() => setSub(s)} style={{ textTransform: 'capitalize' }}>{s}</button>
        ))}
      </div>

      {sub === 'search' && (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              placeholder="Search apt packages… (e.g. htop, ffmpeg, nodejs)"
              style={SINPUT}
            />
            <button className="btn-accent" onClick={() => doSearch()} disabled={searching}>
              {searching ? <><span className="spinner" style={{ marginRight: 6 }} />…</> : '⌕ Search'}
            </button>
          </div>

          {results.length > 0 && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--line)' }}>
                    <th style={TH}>Package</th>
                    <th style={TH}>Description</th>
                    <th style={TH}>Status</th>
                    <th style={TH}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(pkg => (
                    <tr key={pkg.name} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={TD}>
                        <button onClick={() => setInfoPkg(pkg.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontFamily: 'monospace', fontSize: 13, padding: 0 }}>
                          {pkg.name}
                        </button>
                      </td>
                      <td style={{ ...TD, color: 'var(--text-2)', maxWidth: 380 }}>{pkg.desc}</td>
                      <td style={TD}><Badge installed={pkg.installed} /></td>
                      <td style={TD}>
                        {pkg.installed ? (
                          <button className="btn-ghost" style={ABTN} onClick={() => run('remove', pkg.name, onDone)} disabled={!!actionPkg}>
                            {actionPkg === pkg.name ? <span className="spinner" /> : 'Remove'}
                          </button>
                        ) : (
                          <button className="btn-accent" style={ABTN} onClick={() => run('install', pkg.name, onDone)} disabled={!!actionPkg}>
                            {actionPkg === pkg.name ? <span className="spinner" /> : 'Install'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {results.length === 0 && !searching && query && (
            <div className="muted" style={{ textAlign: 'center', padding: 32 }}>No packages found for "{query}"</div>
          )}
        </>
      )}

      {sub === 'installed' && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={instFilter}
              onChange={e => setInstFilter(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && loadInstalled(e.target.value)}
              placeholder="Filter installed packages…"
              style={SINPUT}
            />
            <button className="btn-ghost" onClick={() => loadInstalled(instFilter)} disabled={instLoading}>
              {instLoading ? <span className="spinner" /> : '↻'}
            </button>
            <span className="mono muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{installed.length} packages</span>
          </div>

          {instLoading ? (
            <div className="muted" style={{ textAlign: 'center', padding: 32 }}>Loading…</div>
          ) : (
            <div className="card" style={{ overflowX: 'auto', maxHeight: '60vh', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--surface-1)', zIndex: 1 }}>
                  <tr style={{ borderBottom: '1px solid var(--line)' }}>
                    <th style={TH}>Package</th>
                    <th style={TH}>Version</th>
                    <th style={TH}>Size</th>
                    <th style={TH}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {installed.map(pkg => (
                    <tr key={pkg.name} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={TD}>
                        <button onClick={() => setInfoPkg(pkg.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontFamily: 'monospace', fontSize: 12, padding: 0 }}>
                          {pkg.name}
                        </button>
                      </td>
                      <td style={{ ...TD, fontFamily: 'monospace', color: 'var(--text-3)', fontSize: 11 }}>{pkg.version}</td>
                      <td style={{ ...TD, fontFamily: 'monospace', color: 'var(--text-3)', fontSize: 11 }}>
                        {pkg.size >= 1024 ? `${(pkg.size / 1024).toFixed(1)} MB` : `${pkg.size} KB`}
                      </td>
                      <td style={TD}>
                        <button className="btn-ghost" style={ABTN} onClick={() => run('remove', pkg.name, onDone)} disabled={!!actionPkg}>
                          {actionPkg === pkg.name ? <span className="spinner" /> : 'Remove'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {installed.length === 0 && (
                    <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 32 }}>No packages found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {logLines.length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 6 }}>
            {actionPkg ? <><span className="spinner" style={{ marginRight: 6 }} />Running {actionPkg}…</> : 'Output:'}
          </div>
          <StreamLog lines={logLines} />
        </div>
      )}

      {infoPkg && <PkgInfoModal name={infoPkg} onClose={() => setInfoPkg(null)} />}
    </div>
  );
}

const TH   = { padding: '8px 12px', textAlign: 'left', color: 'var(--text-3)', fontWeight: 500, fontSize: 11, whiteSpace: 'nowrap' };
const TD   = { padding: '8px 12px' };
const ABTN = { fontSize: 11, padding: '3px 10px' };
const SINPUT = {
  flex: 1,
  padding: '6px 10px',
  background: 'var(--surface-3)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  fontSize: 13,
  color: 'var(--text-1)',
  outline: 'none',
};
